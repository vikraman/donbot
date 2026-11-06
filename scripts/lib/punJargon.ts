export interface JargonJoke {
  pattern: RegExp
  replies: readonly [string, ...string[]]
}

// trigger -> replies; keys double as the repeat-suppression word
export const JARGON: Record<string, JargonJoke> = {
  // category theory
  monad: { pattern: /\bmonads?\b/i, replies: ["A monad is just a monoid in the category of endofunctors, what's the problem?", 'Monads are burritos. Do not ask follow-up questions.'] },
  monoid: { pattern: /\bmonoids?\b/i, replies: ['A monoid is a semigroup that finally found its identity.'] },
  yoneda: { pattern: /\byoneda\b/i, replies: ['Yoneda says you are what you relate to. Choose your friends wisely.'] },
  category: { pattern: /\bcategory theory\b/i, replies: ['Category theory: general abstract nonsense, now with diagrams.'] },
  diagram: { pattern: /\b(?:commutative diagrams?|diagram chas(?:e|ing))\b/i, replies: ['I chased the diagram. It commuted. Nobody was impressed.'] },
  abelian: { pattern: /\babelian\b/i, replies: ["What's purple and commutes? An abelian grape."] },
  isomorphism: { pattern: /\bisomorphi(?:c|sm|sms)\b/i, replies: ['Up to isomorphism, this joke is the same as all the others.'] },

  // type theory and proof assistants
  univalence: { pattern: /\bunivalen(?:ce|t)\b/i, replies: ['Equivalent jokes are equal jokes. Univalence.'] },
  homotopy: { pattern: /\bhomotop(?:y|ic|ies)\b/i, replies: ['Homotopy? I can see where this is going, continuously.'] },
  cubical: { pattern: /\bcubical\b/i, replies: ['Cubical: for when your paths need corners.'] },
  typecheck: { pattern: /\btype ?check(?:s|ed|er|ing)?\b/i, replies: ["It typechecks, therefore it's correct. Probably.", 'If it typechecks, ship it.'] },
  postulate: { pattern: /\bpostulat(?:e|es|ed)\b/i, replies: ["The three scariest words in a proof: 'postulate', 'Admitted', 'sorry'.", 'Postulate it. What could possibly go wrong?'] },
  agda: { pattern: /\bagda\b/i, replies: ["If it compiles in Agda, it's a theorem. If it doesn't, it's a postulate."] },
  haskell: { pattern: /\bhaskell\b/i, replies: ['Haskell: avoid success at all costs.'] },
  lazy: { pattern: /\blazy evaluation\b/i, replies: ["I'll laugh at that once you force it."] },
  ycombinator: { pattern: /\by[- ]?combinator\b/i, replies: ['The Y combinator: recursion for people who refuse to name things.'] },
  currying: { pattern: /\b(?:currying|curried)\b/i, replies: ['Currying: why take two arguments when you can take one, twice?'] },

  // proofs
  lemma: { pattern: /\blemmas?\b/i, replies: ['Lemma? Sounds like a dilemma.', 'Lemma? Sounds like the start of a dilemma.'] },
  zorn: { pattern: /\bzorn\b/i, replies: ["What's yellow and equivalent to the axiom of choice? Zorn's lemon."] },
  choice: { pattern: /\baxiom of choice\b/i, replies: ["The axiom of choice is obviously true, the well-ordering principle obviously false, and who can tell about Zorn's lemma?"] },
  banach: { pattern: /\bbanach[- –]tarski\b/i, replies: ["What's an anagram of Banach–Tarski? Banach–Tarski Banach–Tarski."] },
  godel: { pattern: /\b(?:g[öo]del|incompleteness)\b/i, replies: ['This joke is funny, but that cannot be proven.'] },
  fermat: { pattern: /\bfermat\b/i, replies: ['I have a truly marvellous reply, which this message is too short to contain.'] },
  hilbert: { pattern: /\bhilbert\b/i, replies: ["Hilbert's hotel is full, but there's always room for one more joke."] },
  wlog: { pattern: /\b(?:wlog|without loss of generality)\b/i, replies: ['Without loss of generality, assume the joke is funny.'] },
  contradiction: { pattern: /\bproof by contradiction\b/i, replies: ['Assume this joke is not funny. Contradiction.'] },
  topology: { pattern: /\btopolog(?:y|ist|ical)\b/i, replies: ["A topologist can't tell a coffee mug from a doughnut. Breakfast is confusing."] },
  recursion: { pattern: /\brecursion\b/i, replies: ['To understand recursion, you must first understand recursion.'] },
  induction: { pattern: /\binduction\b/i, replies: ['This joke is funny for n = 0, and if it is funny for n it is funny for n + 1. QED.'] },
  trivial: { pattern: /\btrivial(?:ly)?\b/i, replies: ['Proof left as an exercise for the reader.', 'Trivial, says everyone who already knows the proof.'] },

  // programming
  regex: { pattern: /\b(?:regexp?|regexes|regular expressions?)\b/i, replies: ['Now you have two problems.'] },
  naming: { pattern: /\b(?:cache invalidation|naming things|off[- ]by[- ]one)\b/i, replies: ['There are two hard problems in computer science: cache invalidation, naming things, and off-by-one errors.'] },
  halting: { pattern: /\bhalting problem\b/i, replies: ["I'd tell you a halting problem joke, but I can't tell if it ends."] },
  ub: { pattern: /\bundefined behaviou?r\b/i, replies: ['Undefined behaviour: the compiler may now make demons fly out of your nose.'] },
  pnp: { pattern: /\b(?:p ?(?:=|vs\.?|versus|!=) ?np|np[- ]complete|np[- ]hard)\b/i, replies: ['I have a proof that P = NP, but this message is too short to contain it.'] },
  turing: { pattern: /\bturing[- ]complete\b/i, replies: ['Turing complete? So is PowerPoint.'] },
  segfault: { pattern: /\b(?:segfaults?|segfaulted|segmentation fault)\b/i, replies: ['Segmentation fault (core dumped). Anyway, how was your day?'] },
  null: { pattern: /\bnull pointers?\b/i, replies: ["Null: the billion-dollar mistake. Hoare said so himself."] },
  float: { pattern: /\bfloating[- ]point\b/i, replies: ['0.1 + 0.2 = 0.30000000000000004. Close enough.'] },
  race: { pattern: /\brace conditions?\b/i, replies: ["Race joke condition a I'd you tell."] },
  deadlock: { pattern: /\bdeadlock(?:s|ed)?\b/i, replies: ["I'll tell you a deadlock joke as soon as you tell me one."] },
  udp: { pattern: /\budp\b/i, replies: ["I'd tell you a UDP joke, but you might not get it."] },
  tcp: { pattern: /\btcp\b/i, replies: ["Would you like to hear a TCP joke? Yes, I'd like to hear a TCP joke. OK, I'll tell you a TCP joke."] },
  dns: { pattern: /\bdns\b/i, replies: ["It's not DNS. There's no way it's DNS. It was DNS."] },
  forcepush: { pattern: /\b(?:force[- ]push(?:ed|ing)?|push --force)\b/i, replies: ['git push --force: for when you want new enemies.'] },
  borrow: { pattern: /\bborrow checker\b/i, replies: ['The borrow checker has concerns.'] },
  nan: { pattern: /\bNaN\b/, replies: ["typeof NaN === 'number'. Sleep well."] }
}
