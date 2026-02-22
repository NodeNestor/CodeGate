/**
 * Name dictionaries for the name guardrail.
 *
 * Contains first/last name sets, stopwords, and fake name pools.
 */

export const COMMON_FIRST_NAMES = new Set([
  // English
  "james", "john", "robert", "michael", "david", "william", "richard", "joseph",
  "thomas", "charles", "christopher", "daniel", "matthew", "anthony", "mark",
  "donald", "steven", "paul", "andrew", "joshua", "kenneth", "kevin", "brian",
  "george", "timothy", "ronald", "edward", "jason", "jeffrey", "ryan",
  "jacob", "gary", "nicholas", "eric", "jonathan", "stephen", "larry", "justin",
  "scott", "brandon", "benjamin", "samuel", "raymond", "gregory", "frank",
  "alexander", "patrick", "jack", "dennis", "jerry", "tyler", "aaron", "jose",
  "adam", "nathan", "henry", "peter", "zachary", "douglas", "harold", "kyle",
  "noah", "gerald", "ethan", "carl", "terry", "sean", "austin", "arthur",
  "lawrence", "jesse", "dylan", "bryan", "joe", "jordan", "billy", "bruce",
  "albert", "willie", "gabriel", "logan", "ralph", "roy", "eugene", "russell",
  "bobby", "mason", "philip", "louis", "harry", "vincent", "martin", "elijah",
  "mary", "patricia", "jennifer", "linda", "barbara", "elizabeth", "susan",
  "jessica", "sarah", "karen", "lisa", "nancy", "betty", "margaret", "sandra",
  "ashley", "dorothy", "kimberly", "emily", "donna", "michelle", "carol",
  "amanda", "melissa", "deborah", "stephanie", "rebecca", "sharon", "laura",
  "cynthia", "kathleen", "amy", "angela", "shirley", "anna", "brenda", "pamela",
  "emma", "nicole", "helen", "samantha", "katherine", "christine", "debra",
  "rachel", "carolyn", "janet", "catherine", "maria", "heather", "diane",
  "ruth", "julie", "olivia", "joyce", "virginia", "victoria", "kelly", "lauren",
  "christina", "joan", "evelyn", "judith", "megan", "andrea", "cheryl", "hannah",
  "jacqueline", "martha", "gloria", "teresa", "ann", "sara", "madison", "frances",
  "kathryn", "janice", "jean", "abigail", "alice", "julia", "judy", "sophia",
  "grace", "denise", "amber", "doris", "marilyn", "danielle", "beverly", "isabella",
  "theresa", "diana", "natalie", "brittany", "charlotte", "marie", "kayla", "alexis",
  // Scandinavian
  "ludde", "ludvig", "lars", "erik", "olof", "anders", "sven", "karl", "magnus",
  "nils", "björn", "gunnar", "leif", "axel", "oscar", "hugo", "elias", "liam",
  "astrid", "ingrid", "sigrid", "freya", "linnea", "ebba", "saga", "maja",
  // German
  "hans", "fritz", "klaus", "stefan", "wolfgang", "dieter", "jürgen", "uwe",
  "petra", "monika", "ursula", "sabine", "claudia", "heike",
  // Spanish
  "carlos", "miguel", "pedro", "pablo", "diego", "javier", "sergio",
  "maria", "carmen", "elena", "lucia", "sofia", "rosa", "isabel",
  // East Asian (romanised)
  "wei", "ming", "chen", "wang", "zhang", "liu", "yang", "huang", "yuki",
  "kenji", "takashi", "hiroshi", "naoki", "akira", "ryu", "satoshi",
  // South Asian
  "raj", "priya", "amit", "rahul", "deepak", "sanjay", "vikram", "anil",
  "anita", "sunita", "kavita", "ravi", "suresh", "mahesh",
]);

export const COMMON_LAST_NAMES = new Set([
  "smith", "johnson", "williams", "brown", "jones", "garcia", "miller", "davis",
  "rodriguez", "martinez", "hernandez", "lopez", "gonzalez", "wilson", "anderson",
  "thomas", "taylor", "moore", "jackson", "martin", "lee", "perez", "thompson",
  "white", "harris", "sanchez", "clark", "ramirez", "lewis", "robinson",
  "walker", "young", "allen", "king", "wright", "scott", "torres", "nguyen",
  "hill", "flores", "green", "adams", "nelson", "baker", "hall", "rivera",
  "campbell", "mitchell", "carter", "roberts", "gomez", "phillips", "evans",
  "turner", "diaz", "parker", "cruz", "edwards", "collins", "reyes", "stewart",
  "morris", "morales", "murphy", "cook", "rogers", "gutierrez", "ortiz", "morgan",
  "cooper", "peterson", "bailey", "reed", "kelly", "howard", "ramos", "kim",
  "cox", "ward", "richardson", "watson", "brooks", "chavez", "wood", "james",
  "bennett", "gray", "mendoza", "ruiz", "hughes", "price", "alvarez", "castillo",
  "sanders", "patel", "myers", "long", "ross", "foster", "jimenez", "powell",
  "jenkins", "perry", "russell", "sullivan", "bell", "coleman", "butler",
  "henderson", "barnes", "gonzales", "fisher", "vasquez", "simmons", "graham",
  "jordan", "reynolds", "hamilton", "ford", "wallace", "gibson", "spencer",
  // Scandinavian
  "andersson", "johansson", "karlsson", "nilsson", "eriksson", "larsson",
  "olsson", "persson", "svensson", "gustafsson", "pettersson", "jonsson",
  "lindberg", "lindström", "lindgren", "berg", "berglund", "ström",
  // German
  "müller", "schmidt", "schneider", "fischer", "weber", "meyer", "wagner",
  "becker", "schulz", "hoffmann", "koch", "richter", "wolf", "schröder",
  // East Asian
  "wang", "li", "zhang", "liu", "chen", "yang", "huang", "zhao", "wu", "zhou",
  "xu", "sun", "tanaka", "suzuki", "watanabe", "yamamoto", "nakamura", "sato",
  "park", "choi", "jung", "kang",
]);

export const NAME_STOPWORDS = new Set([
  // Programming
  "string", "number", "boolean", "object", "array", "function", "class", "import",
  "export", "return", "const", "async", "await", "error", "debug", "info",
  "warning", "success", "failed", "true", "false", "null", "undefined", "default",
  "select", "option", "button", "input", "label", "table", "column", "index",
  "service", "server", "client", "model", "proxy", "config", "status", "result",
  "request", "response", "message", "content", "system", "create", "update",
  "delete", "read", "write", "build", "start", "stop", "running", "pending",
  // Common words that could match patterns
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december",
  "north", "south", "east", "west", "main", "test", "hello", "world",
  // Single-word names that are also common words
  "will", "bill", "frank", "grace", "hope", "joy", "max", "may",
  "dawn", "summer", "autumn", "winter", "spring", "amber", "ruby",
  "violet", "iris", "ivy", "holly", "lily", "rose", "brook",
]);

export const FAKE_FIRST_NAMES = [
  "Alex", "Jordan", "Casey", "Taylor", "Morgan", "Riley", "Quinn", "Avery",
  "Dakota", "Skyler", "Jamie", "Parker", "Rowan", "Finley", "Sage", "Emery",
  "Hayden", "Reese", "Blair", "Drew", "Cameron", "Phoenix", "Remy", "Peyton",
  "Shea", "Robin", "Spencer", "Tatum", "Val", "Winter", "Arden", "Blake",
  "Charlie", "Devon", "Eden", "Frankie", "Gray", "Harley", "Indigo", "Jules",
  "Kai", "Lane", "Marley", "Noel", "Oakley", "Palmer", "Raven", "Sawyer",
];

export const FAKE_LAST_NAMES = [
  "Morgan", "Lee", "Rivera", "Chen", "Bailey", "Brooks", "Foster", "Hayes",
  "Kim", "Patel", "Cruz", "Diaz", "Ellis", "Grant", "Harper", "Huang",
  "Iyer", "James", "Kelly", "Lambert", "Mills", "Nash", "Ortiz", "Park",
  "Quinn", "Reed", "Singh", "Torres", "Voss", "Walsh", "Young", "Zhang",
  "Adler", "Burns", "Carter", "Drake", "Evans", "Flores", "Gomez", "Hart",
  "Jensen", "Khan", "Liu", "Moore", "Novak", "Price", "Russo", "Scott",
];

/** Pre-computed set of all fake names (lowercase) to avoid re-replacing our own output. */
export const FAKE_NAMES_LOWER = new Set([
  ...FAKE_FIRST_NAMES.map((n) => n.toLowerCase()),
  ...FAKE_LAST_NAMES.map((n) => n.toLowerCase()),
]);
