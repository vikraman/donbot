{- cabal:
build-depends: base, Agda ==2.9.0, aeson, bytestring, containers, deepseq, text, unordered-containers
default-language: GHC2021
ghc-options: -O1 -rtsopts "-with-rtsopts=-A64m"
-}
-- agda index backend, definitions as ndjson
{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}

import Agda.Compiler.Backend hiding ((.=))
import Agda.Compiler.Common (curIF, curMName)
import Agda.Interaction.Options (lensOptPrintPatternSynonyms)
import Agda.Main (runAgda)
import Agda.Syntax.Abstract qualified as A
import Agda.Syntax.Abstract.Name (AbstractName (..), WhyInScope (..), headAmbQ, mnameToQName, nameId)
import Agda.Syntax.Common (Associativity (..), BoundVariablePosition (..), Fixity (..), FixityLevel (..), Hiding (..), NameId, Notation, NotationPart (..), Ranged (..), getHiding, namedArg, theFixity, theNotation, unArg, visible)
import Agda.Syntax.Common.Pretty (Pretty, prettyShow, render)
import Agda.Syntax.Internal qualified as I
import Agda.Syntax.Position (posLine, posPos, rStart')
import Agda.Syntax.Scope.Base (NameSpace (..), NameSpaceId (..), Scope (..), scopeNameSpaces)
import Agda.Syntax.Translation.InternalToAbstract (reify)
import Agda.TypeChecking.Pretty (prettyTCM)
import Agda.TypeChecking.Reduce (reduce)
import Agda.TypeChecking.Substitute (TelV (..), absBody)
import Agda.TypeChecking.Telescope (telView)
import Agda.Utils.GetOpt (ArgDescr (..), OptDescr (..))
import Agda.Utils.List1 qualified as List1
import Agda.Utils.WithDefault (WithDefault' (..))
import Agda.Version (version)
import Control.DeepSeq (NFData (..))
import Control.Monad (forM)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson ((.=))
import Data.Aeson qualified as J
import Data.ByteString.Lazy.Char8 qualified as BL
import Data.Char (isSpace)
import Data.HashMap.Strict qualified as HMap
import Data.List (elemIndex, isPrefixOf, isSuffixOf)
import Data.Map qualified as Map
import Data.Maybe (catMaybes, fromMaybe)
import Data.Set qualified as Set
import Data.Text qualified as T

data Opts = Opts
  { optEnabled :: Bool,
    optOut :: FilePath,
    optLib :: String,
    optCommit :: String,
    optUrl :: String,
    optSource :: String,
    optModules :: [String],
    optBuild :: String
  }

instance NFData Opts where
  rnf (Opts a b c d e f g h) = rnf a `seq` rnf b `seq` rnf c `seq` rnf d `seq` rnf e `seq` rnf f `seq` rnf g `seq` rnf h

defaultOpts :: Opts
defaultOpts = Opts False "index.ndjson" "" "" "" "" [] ""

flags :: [OptDescr (Flag Opts)]
flags =
  [ Option [] ["index"] (NoArg $ \o -> pure o {optEnabled = True}) "dump a search index of all definitions",
    Option [] ["index-out"] (ReqArg (\f o -> pure o {optOut = f}) "FILE") "index file (ndjson)",
    Option [] ["index-lib"] (ReqArg (\s o -> pure o {optLib = s}) "NAME") "library name",
    Option [] ["index-commit"] (ReqArg (\s o -> pure o {optCommit = s}) "SHA") "library commit",
    Option [] ["index-url"] (ReqArg (\s o -> pure o {optUrl = s}) "URL") "base url of the html listings",
    Option [] ["index-build"] (ReqArg (\s o -> pure o {optBuild = s}) "ID") "indexer build, so loaders reload when it changes",
    Option [] ["index-source"] (ReqArg (\s o -> pure o {optSource = s}) "URL") "base url of the sources at the indexed commit",
    Option [] ["index-modules"] (ReqArg (\s o -> pure o {optModules = optModules o ++ words (map (\c -> if c == ',' then ' ' else c) s)}) "PREFIXES") "only modules under these prefixes, plus agda's builtins"
  ]

-- reified type, hidden args dropped
data Tm
  = MVar NameId T.Text
  | MCon QName
  | MApp Tm [(Int, Tm)]
  | MPi Int (Maybe NameId) Tm Tm
  | MLam Int NameId Tm
  | MLit T.Text
  | MHole
  | MOther

data Entry = Entry
  { eName, eModule, eFile, eKind :: T.Text,
    eType :: T.Text,
    eTerm :: Tm,
    eUnfolded :: Maybe Tm,
    eQName :: QName,
    eLine, ePos :: Word,
    eCopy :: Bool,
    eAlias :: Maybe T.Text,
    eDepth :: Int
  }

-- parse and normalise info
data Info = Info
  { iConcrete :: T.Text,
    iFixity :: Maybe (T.Text, Double),
    iPars :: Int,
    iSame :: Maybe (T.Text, Maybe ([Int], Int)),
    iLevel :: Bool,
    iSyntax :: Notation,
    -- alias body and explicit params
    iTemplate :: Maybe (Tpl, [Bool]),
    -- record constructor fields
    iFields :: [QName]
  }

-- alias body, params by position
data Tpl
  = PParam Int [(Int, Tpl)]
  | PBound Int [(Int, Tpl)]
  | PCon QName [(Int, Tpl)]
  | PLam Int Tpl
  | PLit T.Text
  | PAny

-- index contents
type Mod = ([Entry], Set.Set T.Text, Map.Map QName Info, Map.Map T.Text T.Text)

backend :: Backend' Opts Opts (Set.Set QName) Mod (Maybe Entry)
backend =
  Backend'
    { backendName = "index",
      backendVersion = Nothing,
      options = defaultOpts,
      commandLineFlags = flags,
      isEnabled = optEnabled,
      preCompile = pure,
      postCompile = writeIndex,
      preModule = \o _ m _ -> if wanted o (prettyShow m) then Recompile <$> exported else pure (Skip ([], Set.empty, Map.empty, Map.empty)),
      postModule = \_ _ _ _ defs -> finish (catMaybes defs),
      compileDef = \_ pub _ def -> entry pub def,
      scopeCheckingSuffices = False,
      mayEraseType = \_ -> pure True,
      backendInteractTop = Nothing,
      backendInteractHole = Nothing
    }

-- dependency modules are its own
wanted :: Opts -> String -> Bool
wanted o m = null (optModules o) || any under ("Agda" : optModules o)
  where
    under p = m == p || (p ++ ".") `isPrefixOf` m

finish :: [Entry] -> TCM Mod
finish defs = do
  as <- aliases
  ms <- modules
  let es = defs ++ as
      used = Set.fromList (concatMap (\e -> eQName e : names (eTerm e) ++ foldMap names (eUnfolded e)) es)
  is <- closure used
  bs <- builtins
  pure (es, ms, is, bs)

-- literal constructors and functions
builtins :: TCM (Map.Map T.Text T.Text)
builtins =
  Map.fromList . catMaybes
    <$> mapM
      (\(k, b) -> fmap (\q -> (k, text q)) <$> getBuiltinName' b)
      [("zero", builtinZero), ("suc", builtinSuc), ("fromNat", builtinFromNat), ("fromNeg", builtinFromNeg), ("fromString", builtinFromString)]

-- exported names
exported :: TCM (Set.Set QName)
exported = do
  i <- curIF
  setScope (iInsideScope i)
  pure $
    Set.fromList
      [ anameName a
      | s <- Map.elems (iScope i),
        (PublicNS, ns) <- scopeNameSpaces s,
        as <- Map.elems (nsNames ns),
        a <- List1.toList as
      ]

modules :: TCM (Set.Set T.Text)
modules = do
  i <- curIF
  let defs = HMap.keys (iSignature i ^. sigDefinitions)
  pure . Set.fromList . map (T.pack . prettyShow) $
    iModuleName i : Map.keys (iScope i) ++ map qnameModule defs

text :: (Pretty a) => a -> T.Text
text = T.pack . prettyShow

entry :: Set.Set QName -> Definition -> TCM (Maybe Entry)
entry pub def
  | not (Set.member q pub) || hidden = pure Nothing
  | otherwise = case kind (theDef def) of
      Nothing -> pure Nothing
      Just "con" | prettyShow (qnameName q) == "constructor" -> pure Nothing
      Just k -> do
        top <- curMName
        -- file-level copies only
        if defCopy def && stripAnon (text (qnameModule q)) /= text top
          then pure Nothing
          else Just <$> make k def
  where
    q = defName def
    hidden = isExtendedLambdaName q || isAbsurdLambdaName q || "-generalized" `isSuffixOf` prettyShow q
    stripAnon m = maybe m stripAnon (T.stripSuffix "._" m)

make :: T.Text -> Definition -> TCM Entry
make k def = do
  top <- curMName
  ty <- T.pack . unwords . words . render <$> prettyTCM (defType def)
  tm <- term <$> plain (reify (defType def))
  -- unfolded type
  unf <- unfold (defType def)
  utm <- traverse (fmap term . plain . reify) unf
  let pos = rStart' (nameBindingSite (qnameName q))
  pure
    Entry
      { eName = text (qnameName q),
        eModule = text (qnameModule q),
        eFile = text top,
        eKind = k,
        eType = ty,
        eTerm = tm,
        eUnfolded = utm,
        eQName = q,
        eLine = maybe 0 (fromIntegral . posLine) pos,
        ePos = maybe 0 (fromIntegral . posPos) pos,
        -- module application type
        eCopy = defCopy def,
        eAlias = Nothing,
        eDepth = 0
      }
  where
    q = defName def

-- constructors, not pattern synonyms
plain :: TCM a -> TCM a
plain = locallyTCState (stPragmaOptions . lensOptPrintPatternSynonyms) (const (Value False))

-- conclusion unfolded once to a pi
unfold :: I.Type -> TCM (Maybe I.Type)
unfold t = case I.unEl t of
  I.Pi a b ->
    fmap (\b' -> t {I.unEl = I.Pi a b'}) <$> case b of
      I.Abs x _ -> fmap (I.Abs x) <$> underAbstraction a b unfold
      I.NoAbs x u -> fmap (I.NoAbs x) <$> unfold u
  _ -> do
    t' <- reduce t
    pure $ case I.unEl t' of
      I.Pi {} -> Just t'
      _ -> Nothing

hid :: Hiding -> Int
hid = \case
  NotHidden -> 0
  Hidden -> 1
  Instance {} -> 2

term :: A.Expr -> Tm
term = \case
  A.Var x -> MVar (nameId x) (text x)
  A.Def' q _ -> MCon q
  A.Proj _ q -> MCon (headAmbQ q)
  A.Con q -> MCon (headAmbQ q)
  A.PatternSyn q -> MCon (headAmbQ q)
  A.Macro q -> MCon q
  A.Lit _ l -> MLit (text l)
  A.Underscore {} -> MHole
  A.QuestionMark {} -> MHole
  e@A.App {} -> spine e []
  A.Pi _ tel b -> foldr pis (term b) (List1.toList tel)
  A.Fun _ a b -> MPi (hid (getHiding a)) Nothing (term (unArg a)) (term b)
  A.Lam _ bind b -> foldr (uncurry MLam) (term b) (lamBinders bind)
  A.Generalized _ t -> term t
  A.Dot _ e -> term e
  A.ScopedExpr _ e -> term e
  A.Qualified _ e -> term e
  A.Highlighted _ e -> term e
  A.DontCare e -> term e
  _ -> MOther
  where
    spine (A.App _ f a) as = spine f ((hid (getHiding a), namedArg a) : as)
    spine (A.ScopedExpr _ f) as = spine f as
    spine f as = foldl elim (term f) as
    -- x .fst y as fst x y
    elim acc (_, e) | Just q <- proj e = MApp (MCon q) [(0, acc)]
    elim (MApp h xs) (h', e) = MApp h (xs ++ [(h', term e)])
    elim acc (h, e) = MApp acc [(h, term e)]
    proj = \case
      A.Proj _ q -> Just (headAmbQ q)
      A.ScopedExpr _ e -> proj e
      A.Dot _ e -> proj e
      _ -> Nothing
    pis (A.TBind _ _ xs dom) b = foldr (\x -> MPi (hid (getHiding x)) (Just (bound x)) (term dom)) b (List1.toList xs)
    pis A.TLet {} b = b
    bound = nameId . A.unBind . A.binderName . namedArg
    lamBinders = \case
      A.DomainFree _ x -> [(hid (getHiding x), bound x)]
      A.DomainFull (A.TBind _ _ xs _) -> [(hid (getHiding x), bound x) | x <- List1.toList xs]
      A.DomainFull A.TLet {} -> []

names :: Tm -> [QName]
names = \case
  MCon q -> [q]
  MApp f as -> names f ++ concatMap (names . snd) as
  MPi _ _ a b -> names a ++ names b
  MLam _ _ b -> names b
  _ -> []

-- names templates and fields mention
closure :: Set.Set QName -> TCM (Map.Map QName Info)
closure = go (3 :: Int) Map.empty
  where
    go 0 acc _ = pure acc
    go n acc qs = do
      is <- infos (Set.filter (`Map.notMember` acc) qs)
      let acc' = Map.union acc is
          more = Set.fromList (concatMap mentioned (Map.elems is))
      if Set.null (Set.filter (`Map.notMember` acc') more) then pure acc' else go (n - 1) acc' more
    mentioned i = iFields i ++ maybe [] (tplNames . fst) (iTemplate i)
    tplNames = \case
      PParam _ as -> concatMap (tplNames . snd) as
      PBound _ as -> concatMap (tplNames . snd) as
      PCon q as -> q : concatMap (tplNames . snd) as
      PLam _ b -> tplNames b
      PLit _ -> []
      PAny -> []

infos :: Set.Set QName -> TCM (Map.Map QName Info)
infos qs = Map.fromList . catMaybes <$> forM (Set.toList qs) (\q -> fmap (q,) <$> info q)

info :: QName -> TCM (Maybe Info)
info q =
  getConstInfo' q >>= \case
    Left _ -> pure Nothing
    Right def -> do
      pars <- case theDef def of
        Constructor {} -> pure 0
        Function {funProjection = Right p} | Just _ <- projProper p -> pure 0
        _ -> do
          n <- length . filter visible . I.telToList <$> lookupSection (qnameModule q)
          -- record module functions keep the record
          inRecord <-
            getConstInfo' (mnameToQName (qnameModule q)) <&> \case
              Right d | Record {} <- theDef d -> True
              _ -> False
          pure (if inRecord then max 0 (n - 1) else n)
      TelV _ b <- telView (defType def)
      tpl <- if pars > 0 then pure Nothing else template (theDef def)
      fields <- case theDef def of
        Constructor {conData = d} ->
          getConstInfo' d <&> \case
            Right r | Record {recFields = fs} <- theDef r -> map I.unDom fs
            _ -> []
        _ -> pure []
      let lvl = case I.unEl b of
            I.Def l [] -> prettyShow l == "Agda.Primitive.Level"
            _ -> False
      pure . Just $
        Info
          { iConcrete = text (qnameName q),
            iFixity = fixity (theFixity (nameFixity (qnameName q))),
            iPars = pars,
            iSame = same (theDef def),
            iLevel = lvl,
            -- syntax declarations only
            iSyntax = theNotation (nameFixity (qnameName q)),
            iTemplate = tpl,
            iFields = fields
          }
  where
    fixity (Fixity _ (Related l) a) = Just (assoc a, l)
    fixity _ = Nothing
    assoc = \case
      NonAssoc -> "non"
      LeftAssoc -> "left"
      RightAssoc -> "right"

-- alias templates, x ≡ y = PathP (λ _ → A) x y
template :: Defn -> TCM (Maybe (Tpl, [Bool]))
template = \case
  Function {funClauses = [cl], funProjection = Left _}
    | Just body@(I.Def h _) <- I.clauseBody cl,
      Just ps <- mapM pat (I.namedClausePats cl) -> do
        prim <-
          getConstInfo' h <&> \case
            Right d | Axiom {} <- theDef d -> True
            Right d | Primitive {} <- theDef d -> True
            _ -> False
        pure $ if prim then (,map snd ps) <$> go (map fst ps) 0 body else Nothing
  _ -> pure Nothing
  where
    pat p | I.VarP _ x <- namedArg p = Just (I.dbPatVarIndex x, visible p)
    pat _ = Nothing
    go ps k = \case
      I.Var i es
        | i < k -> PBound i <$> args ps k es
        | Just n <- elemIndex (i - k) ps -> PParam n <$> args ps k es
        | otherwise -> Nothing
      I.Def q es -> PCon q <$> args ps k es
      I.Con c _ es -> PCon (I.conName c) <$> args ps k es
      I.Lam ai b -> PLam (hid (getHiding ai)) <$> go ps (k + 1) (absBody b)
      I.Lit l -> Just (PLit (text l))
      -- no level or sort args
      I.Level _ -> Just PAny
      I.Sort _ -> Just PAny
      _ -> Nothing
    args ps k = mapM $ \case
      I.Apply a -> (hid (getHiding a),) <$> go ps k (unArg a)
      -- path application
      I.IApply _ _ r -> (0,) <$> go ps k r
      _ -> Nothing

-- alias explicit args kept
same :: Defn -> Maybe (T.Text, Maybe ([Int], Int))
same = \case
  Function {funClauses = [cl]} | Just body <- I.clauseBody cl -> case body of
    I.Sort _ -> Just ("sort", Nothing)
    I.Def q es
      | Just vs <- mapM var es,
        Just ps <- mapM pat (I.namedClausePats cl),
        map fst vs == map fst ps ->
          let explicit = [i | (i, True) <- ps]
              keep = [k | (i, True) <- vs, Just k <- [elemIndex i explicit]]
           in Just (text q, if keep == [0 .. length explicit - 1] then Nothing else Just (keep, length explicit))
    _ -> Nothing
  _ -> Nothing
  where
    var (I.Apply a) | I.Var i [] <- unArg a = Just (i, visible a)
    var _ = Nothing
    pat p | I.VarP _ x <- namedArg p = Just (I.dbPatVarIndex x, visible p)
    pat _ = Nothing

-- renamed public re-exports
aliases :: TCM [Entry]
aliases = do
  i <- curIF
  catMaybes
    <$> sequence
      [ alias (scopeName s) c a
      | s <- Map.elems (iScope i),
        -- public opens
        (ImportedNS, ns) <- scopeNameSpaces s,
        (c, as) <- Map.toList (nsNames ns),
        let c' = prettyShow c,
        a <- List1.toList as,
        c' /= prettyShow (qnameName (anameName a)) && c' /= "constructor"
      ]
  where
    alias m c a =
      getConstInfo' (anameName a) >>= \case
        Right def | Just k <- kind (theDef def) -> do
          e <- make k def
          -- no source line for renamings
          pure . Just $ e {eName = text c, eModule = text m, eLine = 0, ePos = 0, eCopy = False, eAlias = Just (text (anameName a)), eDepth = depth (anameLineage a)}
        _ -> pure Nothing
    depth w = case w of
      Defined -> 0 :: Int
      Opened _ w' -> 1 + depth w'
      Applied _ w' -> 1 + depth w'

-- shortest unambiguous names
unqualify :: Set.Set T.Text -> T.Text -> T.Text
unqualify mods ty = T.concat (map fix toks)
  where
    toks = T.groupBy (\a b -> delim a == delim b) ty
    delim c = isSpace c || c `elem` ("(){}" :: String)
    proj tok = maybe tok proj (T.stripPrefix "." tok)
    strip tok
      | T.any (== '.') tok = go (T.splitOn "." tok)
      | otherwise = tok
      where
        go parts =
          case [T.intercalate "." (drop k parts) | k <- [length parts - 1, length parts - 2 .. 1], T.intercalate "." (take k parts) `Set.member` mods] of
            short : _ -> short
            [] -> tok
    -- short names to qualified names
    readings = Map.fromListWith Set.union [(strip t, Set.singleton t) | tok <- toks, let t = proj tok, T.any (== '.') t, strip t /= t]
    fix tok
      | Just t <- T.stripPrefix "." tok = "." <> fix t
      | otherwise = case Map.lookup short readings of
          Just names | Set.size names > 1, T.any (== '.') tok -> distinct (Set.toList names)
          _ -> short
      where
        short = strip tok
        suffix k = T.intercalate "." . reverse . take k . reverse . T.splitOn "."
        -- fewest unique trailing segments
        distinct names =
          case [s | k <- [2 .. length (T.splitOn "." tok)], let s = suffix k tok, all (\n -> n == tok || suffix k n /= s) names] of
            s : _ -> s
            [] -> tok

kind :: Defn -> Maybe T.Text
kind d = case d of
  AbstractDefn d' -> kind d'
  Function {funProjection = Right p} | Just _ <- projProper p -> Just "field"
  Function {} | isWithFunction d -> Nothing
  Function {} -> Just "fun"
  Datatype {} -> Just "data"
  Record {} -> Just "record"
  Constructor {} -> Just "con"
  Axiom {} -> Just "postulate"
  Primitive {} -> Just "prim"
  PrimitiveSort {} -> Just "prim"
  _ -> Nothing

-- compact arrays
encode :: Map.Map QName Int -> Tm -> J.Value
encode ix t = go t
  where
    binders = Map.fromList (zip (bound t) [0 :: Int ..])
    bound = \case
      MApp f as -> bound f ++ concatMap (bound . snd) as
      MPi _ x a b -> maybe [] pure x ++ bound a ++ bound b
      MLam _ x b -> x : bound b
      _ -> []
    go = \case
      MVar x n -> maybe (J.toJSON ("f" :: T.Text, n)) (\i -> J.toJSON ("v" :: T.Text, i)) (Map.lookup x binders)
      MCon q -> maybe (J.toJSON ["?" :: T.Text]) (\i -> J.toJSON ("c" :: T.Text, i)) (Map.lookup q ix)
      MApp f [] -> go f
      MApp f as -> J.toJSON (J.String "a" : go f : [J.toJSON (h, go a) | (h, a) <- as])
      MPi h x a b -> J.toJSON [J.String "p", J.toJSON h, maybe J.Null (J.toJSON . (binders Map.!)) x, go a, go b]
      MLam h x b -> J.toJSON [J.String "l", J.toJSON h, J.toJSON (binders Map.! x), go b]
      MLit l -> J.toJSON ("n" :: T.Text, l)
      MHole -> J.toJSON ["_" :: T.Text]
      MOther -> J.toJSON ["?" :: T.Text]

writeIndex :: Opts -> IsMain -> Map.Map TopLevelModuleName Mod -> TCM ()
writeIndex o _ mods = liftIO $ do
  let ms = Set.insert "Agda.Primitive" (foldMap (\(_, m, _, _) -> m) mods)
      all' = concatMap (\(e, _, _, _) -> e) (Map.elems mods)
      is = Map.unions (map (\(_, _, i, _) -> i) (Map.elems mods))
      bs = Map.unions (map (\(_, _, _, b) -> b) (Map.elems mods))
      -- each alias once
      closest a b = if (eDepth a, T.length (eModule a)) <= (eDepth b, T.length (eModule b)) then a else b
      renamed = Map.fromListWith closest [((eName e, t), e) | e <- all', Just t <- [eAlias e]]
      es = [e | e <- all', null (eAlias e)] ++ Map.elems renamed
      ix = Map.fromList (zip (Map.keys is) [0 :: Int ..])
      meta =
        J.object
          [ "library" .= optLib o,
            "commit" .= optCommit o,
            "url" .= optUrl o,
            "source" .= optSource o,
            "agda" .= T.pack version,
            "build" .= optBuild o,
            "count" .= length es,
            "names" .= Map.size is,
            "format" .= (2 :: Int),
            "builtins" .= bs
          ]
      name (q, i) =
        J.object $
          [ "q" .= text q,
            "n" .= iConcrete i
          ]
            <> ["fix" .= [J.toJSON a, J.toJSON l] | Just (a, l) <- [iFixity i]]
            <> ["np" .= iPars i | iPars i > 0]
            <> ["same" .= s | Just (s, _) <- [iSame i]]
            <> ["keep" .= [J.toJSON k, J.toJSON n] | Just (_, Just (k, n)) <- [iSame i]]
            <> ["lvl" .= True | iLevel i]
            <> ["syntax" .= map part (iSyntax i) | not (null (iSyntax i))]
            <> concat [["tpl" .= tpl t, "tplvis" .= vis] | Just (t, vis) <- [iTemplate i]]
            <> ["fields" .= map (ix Map.!) (iFields i) | not (null (iFields i)), all (`Map.member` ix) (iFields i)]
      spine as = [J.toJSON (h, tpl a) | (h, a) <- as]
      tpl = \case
        PParam n as -> J.toJSON (J.String "P" : J.toJSON n : spine as)
        PBound n as -> J.toJSON (J.String "B" : J.toJSON n : spine as)
        PCon q as -> J.toJSON (J.String "C" : J.toJSON (Map.findWithDefault (-1) q ix) : spine as)
        PLam h b -> J.toJSON [J.String "L", J.toJSON h, tpl b]
        PLit l -> J.toJSON [J.String "N", J.toJSON l]
        PAny -> J.toJSON [J.String "W"]
      part = \case
        IdPart x -> J.toJSON ("i" :: T.Text, rangedThing x)
        HolePart _ h -> J.toJSON ("h" :: T.Text, rangedThing (namedArg h), hid (getHiding h))
        VarPart _ v -> J.toJSON ("v" :: T.Text, holeNumber (rangedThing v), varNumber (rangedThing v))
        WildPart v -> J.toJSON ("w" :: T.Text, holeNumber (rangedThing v), varNumber (rangedThing v))
      json e =
        J.object $
          [ "name" .= eName e,
            "module" .= eModule e,
            "file" .= eFile e,
            "kind" .= eKind e,
            "type" .= unqualify ms (eType e),
            "term" .= encode ix (eTerm e),
            "qname" .= fromMaybe (-1) (Map.lookup (eQName e) ix),
            "line" .= eLine e,
            "pos" .= ePos e
          ]
            <> ["unf" .= encode ix u | Just u <- [eUnfolded e]]
            <> ["copy" .= True | eCopy e]
            <> ["alias" .= t | Just t <- [eAlias e]]
      line v = J.encode v <> "\n"
  BL.writeFile (optOut o) $
    line (J.object ["meta" .= meta]) <> foldMap (line . name) (Map.toList is) <> foldMap (line . json) es
  putStrLn $ "indexed " ++ show (length es) ++ " definitions and " ++ show (Map.size is) ++ " names to " ++ optOut o

main :: IO ()
main = runAgda [Backend backend]
