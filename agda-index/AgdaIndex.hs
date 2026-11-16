{- cabal:
build-depends: base, Agda ==2.9.0, aeson, bytestring, containers, deepseq, text, unordered-containers
default-language: GHC2021
ghc-options: -O1 -rtsopts "-with-rtsopts=-A64m"
-}
{-# LANGUAGE OverloadedStrings, TupleSections #-}

-- agda index backend that dumps definitions and their types in json

import Control.DeepSeq (NFData (..))
import Control.Monad.IO.Class (liftIO)
import Data.Aeson ((.=))
import Data.Aeson qualified as J
import Data.ByteString.Lazy qualified as BL
import Data.Char (isSpace)
import Data.List (isSuffixOf)
import Data.Map qualified as Map
import Data.Maybe (catMaybes)
import Data.HashMap.Strict qualified as HMap
import Data.Set qualified as Set
import Data.Text qualified as T
import Agda.Utils.GetOpt (ArgDescr (..), OptDescr (..))

import Agda.Compiler.Backend hiding ((.=))
import Agda.Compiler.Common (curIF, curMName)
import Agda.Main (runAgda)
import Agda.Syntax.Common.Pretty (Pretty, prettyShow, render)
import Agda.Syntax.Position (posLine, posPos, rStart')
import Agda.Syntax.Abstract.Name (AbstractName (..))
import Agda.Syntax.Scope.Base (NameSpace (..), NameSpaceId (..), Scope (..), scopeNameSpaces)
import Agda.TypeChecking.Pretty (prettyTCM)
import Agda.TypeChecking.Substitute (TelV (..), telePi)
import Agda.TypeChecking.Telescope (telView)
import Agda.Utils.List1 qualified as List1

data Opts = Opts
  { optEnabled :: Bool
  , optOut :: FilePath
  , optLib :: String
  , optCommit :: String
  , optUrl :: String
  }

instance NFData Opts where
  rnf (Opts a b c d e) = rnf a `seq` rnf b `seq` rnf c `seq` rnf d `seq` rnf e

defaultOpts :: Opts
defaultOpts = Opts False "index.json" "" "" ""

flags :: [OptDescr (Flag Opts)]
flags =
  [ Option [] ["index"] (NoArg $ \o -> pure o {optEnabled = True}) "dump a search index of all definitions"
  , Option [] ["index-out"] (ReqArg (\f o -> pure o {optOut = f}) "FILE") "index file (json)"
  , Option [] ["index-lib"] (ReqArg (\s o -> pure o {optLib = s}) "NAME") "library name"
  , Option [] ["index-commit"] (ReqArg (\s o -> pure o {optCommit = s}) "SHA") "library commit"
  , Option [] ["index-url"] (ReqArg (\s o -> pure o {optUrl = s}) "URL") "base url of the html listings"
  ]

data Entry = Entry
  { eName, eModule, eFile, eKind :: T.Text
  , eType :: T.Text
  , eNf :: Maybe T.Text
  , eLine, ePos :: Word
  }

-- entries plus every module name seen, for unqualifying
type Mod = ([Entry], Set.Set T.Text)

backend :: Backend' Opts Opts (Set.Set QName) Mod (Maybe Entry)
backend =
  Backend'
    { backendName = "index"
    , backendVersion = Nothing
    , options = defaultOpts
    , commandLineFlags = flags
    , isEnabled = optEnabled
    , preCompile = pure
    , postCompile = writeIndex
    , preModule = \_ _ _ _ -> Recompile <$> exported
    , postModule = \_ _ _ _ defs -> (catMaybes defs,) <$> modules
    , compileDef = \_ pub _ def -> entry pub def
    , scopeCheckingSuffices = False
    , mayEraseType = \_ -> pure True
    , backendInteractTop = Nothing
    , backendInteractHole = Nothing
    }

-- names exported by the current module and its public submodules
exported :: TCM (Set.Set QName)
exported = do
  i <- curIF
  setScope (iInsideScope i)
  pure $
    Set.fromList
      [ anameName a
      | s <- Map.elems (iScope i)
      , (PublicNS, ns) <- scopeNameSpaces s
      , as <- Map.elems (nsNames ns)
      , a <- List1.toList as
      ]

modules :: TCM (Set.Set T.Text)
modules = do
  i <- curIF
  let defs = HMap.keys (iSignature i ^. sigDefinitions)
  pure . Set.fromList . map (T.pack . prettyShow) $
    iModuleName i : Map.keys (iScope i) ++ map qnameModule defs

entry :: Set.Set QName -> Definition -> TCM (Maybe Entry)
entry pub def
  | not (Set.member q pub) || defCopy def || hidden = pure Nothing
  | otherwise = case kind (theDef def) of
      Nothing -> pure Nothing
      Just "con" | prettyShow (qnameName q) == "constructor" -> pure Nothing
      Just k -> do
        ty <- pp (defType def)
        -- full normalisation is too slow
        TelV tel b <- telView (defType def)
        nf <- pp (telePi tel b)
        top <- curMName
        let pos = rStart' (nameBindingSite (qnameName q))
        pure . Just $
          Entry
            { eName = text (qnameName q)
            , eModule = text (qnameModule q)
            , eFile = text top
            , eKind = k
            , eType = ty
            , eNf = if nf == ty || T.length nf > 400 then Nothing else Just nf
            , eLine = maybe 0 (fromIntegral . posLine) pos
            , ePos = maybe 0 (fromIntegral . posPos) pos
            }
  where
    q = defName def
    hidden = isExtendedLambdaName q || isAbsurdLambdaName q || "-generalized" `isSuffixOf` prettyShow q
    pp t = T.pack . unwords . words . render <$> prettyTCM t
    text :: Pretty a => a -> T.Text
    text = T.pack . prettyShow

-- interfaces drop private imports, so names print fully qualified
unqualify :: Set.Set T.Text -> T.Text -> T.Text
unqualify mods = T.concat . map strip . T.groupBy (\a b -> delim a == delim b)
  where
    delim c = isSpace c || c `elem` ("(){}" :: String)
    strip tok
      | Just t <- T.stripPrefix "." tok = "." <> strip t
      | T.any (== '.') tok = go (T.splitOn "." tok)
      | otherwise = tok
      where
        go parts =
          case [ T.intercalate "." (drop k parts) | k <- [length parts - 1, length parts - 2 .. 1], T.intercalate "." (take k parts) `Set.member` mods ] of
            short : _ -> short
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

writeIndex :: Opts -> IsMain -> Map.Map TopLevelModuleName Mod -> TCM ()
writeIndex o _ mods = liftIO $ do
  let ms = Set.insert "Agda.Primitive" (foldMap snd mods)
      es = concatMap fst (Map.elems mods)
      meta =
        J.object
          [ "library" .= optLib o
          , "commit" .= optCommit o
          , "url" .= optUrl o
          , "agda" .= ("2.9.0" :: T.Text)
          , "count" .= length es
          ]
      json e =
        J.object
          [ "name" .= eName e
          , "module" .= eModule e
          , "file" .= eFile e
          , "kind" .= eKind e
          , "type" .= unqualify ms (eType e)
          , "nf" .= fmap (unqualify ms) (eNf e)
          , "line" .= eLine e
          , "pos" .= ePos e
          ]
  BL.writeFile (optOut o) . J.encode $ J.object ["meta" .= meta, "entries" .= map json es]
  putStrLn $ "indexed " ++ show (length es) ++ " definitions to " ++ optOut o

main :: IO ()
main = runAgda [Backend backend]
