package guardrails

import "strings"

// Name dictionaries for the name guardrail.
// Contains first/last name sets, stopwords, and fake name pools.

// CommonFirstNames contains common first names (lowercase) from multiple cultures.
var CommonFirstNames = map[string]bool{
	// English male
	"james": true, "john": true, "robert": true, "michael": true, "david": true,
	"william": true, "richard": true, "joseph": true, "thomas": true, "charles": true,
	"christopher": true, "daniel": true, "matthew": true, "anthony": true, "mark": true,
	"donald": true, "steven": true, "paul": true, "andrew": true, "joshua": true,
	"kenneth": true, "kevin": true, "brian": true, "george": true, "timothy": true,
	"ronald": true, "edward": true, "jason": true, "jeffrey": true, "ryan": true,
	"jacob": true, "gary": true, "nicholas": true, "eric": true, "jonathan": true,
	"stephen": true, "larry": true, "justin": true, "scott": true, "brandon": true,
	"benjamin": true, "samuel": true, "raymond": true, "gregory": true, "frank": true,
	"alexander": true, "patrick": true, "jack": true, "dennis": true, "jerry": true,
	"tyler": true, "aaron": true, "jose": true, "adam": true, "nathan": true,
	"henry": true, "peter": true, "zachary": true, "douglas": true,
	"harold": true, "kyle": true, "noah": true, "gerald": true, "ethan": true,
	"carl": true, "terry": true, "sean": true, "austin": true, "arthur": true,
	"lawrence": true, "jesse": true, "dylan": true, "bryan": true, "joe": true,
	"jordan": true, "billy": true, "bruce": true, "albert": true, "willie": true,
	"gabriel": true, "logan": true, "ralph": true, "roy": true, "eugene": true,
	"russell": true, "bobby": true, "mason": true, "philip": true, "louis": true,
	"harry": true, "vincent": true, "martin": true, "elijah": true,
	// English female
	"mary": true, "patricia": true, "jennifer": true, "linda": true, "barbara": true,
	"elizabeth": true, "susan": true, "jessica": true, "sarah": true, "karen": true,
	"lisa": true, "nancy": true, "betty": true, "margaret": true, "sandra": true,
	"ashley": true, "dorothy": true, "kimberly": true, "emily": true, "donna": true,
	"michelle": true, "carol": true, "amanda": true, "melissa": true, "deborah": true,
	"stephanie": true, "rebecca": true, "sharon": true, "laura": true, "cynthia": true,
	"kathleen": true, "amy": true, "angela": true, "shirley": true, "anna": true,
	"brenda": true, "pamela": true, "emma": true, "nicole": true, "helen": true,
	"samantha": true, "katherine": true, "christine": true, "debra": true, "rachel": true,
	"carolyn": true, "janet": true, "catherine": true, "maria": true, "heather": true,
	"diane": true, "ruth": true, "julie": true, "olivia": true, "joyce": true,
	"virginia": true, "victoria": true, "kelly": true, "lauren": true, "christina": true,
	"joan": true, "evelyn": true, "judith": true, "megan": true, "andrea": true,
	"cheryl": true, "hannah": true, "jacqueline": true, "martha": true, "gloria": true,
	"teresa": true, "ann": true, "sara": true, "madison": true, "frances": true,
	"kathryn": true, "janice": true, "jean": true, "abigail": true, "alice": true,
	"julia": true, "judy": true, "sophia": true, "denise": true, "doris": true,
	"marilyn": true, "danielle": true, "beverly": true, "isabella": true, "theresa": true,
	"diana": true, "natalie": true, "brittany": true, "charlotte": true, "marie": true,
	"kayla": true, "alexis": true,
	// Scandinavian
	"ludde": true, "ludvig": true, "lars": true, "erik": true, "olof": true,
	"anders": true, "sven": true, "karl": true, "magnus": true, "nils": true,
	"astrid": true, "ingrid": true, "sigrid": true, "freya": true, "linnea": true,
	"björn": true, "gunnar": true, "leif": true, "axel": true, "oscar": true,
	"hugo": true, "elias": true, "liam": true, "ebba": true, "saga": true,
	"maja": true,
	// German
	"hans": true, "fritz": true, "klaus": true, "stefan": true, "wolfgang": true,
	"petra": true, "monika": true, "ursula": true, "sabine": true, "claudia": true,
	"dieter": true, "jürgen": true, "uwe": true, "heike": true,
	// Spanish
	"carlos": true, "miguel": true, "pedro": true, "pablo": true, "diego": true,
	"javier": true, "sergio": true, "carmen": true, "elena": true, "lucia": true,
	"sofia": true, "rosa": true, "isabel": true,
	// East Asian (romanised)
	"wei": true, "ming": true, "chen": true, "wang": true, "zhang": true,
	"liu": true, "yang": true, "huang": true, "yuki": true, "kenji": true,
	"takashi": true, "hiroshi": true, "naoki": true, "akira": true, "ryu": true,
	"satoshi": true,
	// South Asian
	"raj": true, "priya": true, "amit": true, "rahul": true, "deepak": true,
	"sanjay": true, "vikram": true, "anil": true, "anita": true, "sunita": true,
	"kavita": true, "ravi": true, "suresh": true, "mahesh": true,
}

// CommonLastNames contains common last names (lowercase) from multiple cultures.
var CommonLastNames = map[string]bool{
	"smith": true, "johnson": true, "williams": true, "brown": true, "jones": true,
	"garcia": true, "miller": true, "davis": true, "rodriguez": true, "martinez": true,
	"hernandez": true, "lopez": true, "gonzalez": true, "wilson": true, "anderson": true,
	"thomas": true, "taylor": true, "moore": true, "jackson": true, "martin": true,
	"lee": true, "perez": true, "thompson": true, "white": true, "harris": true,
	"sanchez": true, "clark": true, "ramirez": true, "lewis": true, "robinson": true,
	"walker": true, "young": true, "allen": true, "king": true, "wright": true,
	"scott": true, "torres": true, "nguyen": true, "hill": true, "flores": true,
	"green": true, "adams": true, "nelson": true, "baker": true, "hall": true,
	"rivera": true, "campbell": true, "mitchell": true, "carter": true, "roberts": true,
	"gomez": true, "phillips": true, "evans": true, "turner": true, "diaz": true,
	"parker": true, "cruz": true, "edwards": true, "collins": true, "reyes": true,
	"stewart": true, "morris": true, "morales": true, "murphy": true, "cook": true,
	"rogers": true, "gutierrez": true, "ortiz": true, "morgan": true, "cooper": true,
	"peterson": true, "bailey": true, "reed": true, "kelly": true, "howard": true,
	"ramos": true, "kim": true, "cox": true, "ward": true, "richardson": true,
	"watson": true, "brooks": true, "chavez": true, "wood": true, "james": true,
	"bennett": true, "gray": true, "mendoza": true, "ruiz": true, "hughes": true,
	"price": true, "alvarez": true, "castillo": true, "sanders": true, "patel": true,
	"myers": true, "long": true, "ross": true, "foster": true, "jimenez": true,
	"powell": true, "jenkins": true, "perry": true, "russell": true, "sullivan": true,
	"bell": true, "coleman": true, "butler": true, "henderson": true, "barnes": true,
	"gonzales": true, "fisher": true, "vasquez": true, "simmons": true, "graham": true,
	"jordan": true, "reynolds": true, "hamilton": true, "ford": true, "wallace": true,
	"gibson": true, "spencer": true,
	// Scandinavian
	"andersson": true, "johansson": true, "karlsson": true, "nilsson": true,
	"eriksson": true, "larsson": true, "olsson": true, "persson": true,
	"svensson": true, "gustafsson": true, "pettersson": true, "jonsson": true,
	"lindberg": true, "lindström": true, "lindgren": true, "berg": true,
	"berglund": true, "ström": true,
	// German
	"mueller": true, "schmidt": true, "schneider": true, "fischer": true,
	"weber": true, "meyer": true, "wagner": true, "becker": true, "schulz": true,
	"müller": true, "hoffmann": true, "koch": true, "richter": true, "wolf": true,
	"schröder": true,
	// East Asian
	"wang": true, "li": true, "zhang": true, "liu": true, "chen": true,
	"yang": true, "huang": true, "zhao": true, "wu": true, "zhou": true,
	"tanaka": true, "suzuki": true, "watanabe": true, "yamamoto": true, "nakamura": true,
	"sato": true, "park": true, "choi": true, "jung": true, "kang": true,
	"xu": true, "sun": true,
}

// NameStopwords contains words that should not be treated as names.
var NameStopwords = map[string]bool{
	// Programming
	"string": true, "number": true, "boolean": true, "object": true, "array": true,
	"function": true, "class": true, "import": true, "export": true, "return": true,
	"const": true, "async": true, "await": true, "error": true, "debug": true,
	"info": true, "warning": true, "success": true, "failed": true, "true": true,
	"false": true, "null": true, "undefined": true, "default": true, "select": true,
	"option": true, "button": true, "input": true, "label": true, "table": true,
	"column": true, "index": true, "service": true, "server": true, "client": true,
	"model": true, "proxy": true, "config": true, "status": true, "result": true,
	"request": true, "response": true, "message": true, "content": true, "system": true,
	"create": true, "update": true, "delete": true, "read": true, "write": true,
	"build": true, "start": true, "stop": true, "running": true, "pending": true,
	// Common words that could match patterns
	"monday": true, "tuesday": true, "wednesday": true, "thursday": true,
	"friday": true, "saturday": true, "sunday": true, "january": true,
	"february": true, "march": true, "april": true, "june": true, "july": true,
	"august": true, "september": true, "october": true, "november": true,
	"december": true, "north": true, "south": true, "east": true, "west": true,
	"main": true, "test": true, "hello": true, "world": true,
	// Single-word names that are also common words
	"will": true, "bill": true, "frank": true, "grace": true, "hope": true,
	"joy": true, "max": true, "may": true, "dawn": true, "summer": true,
	"autumn": true, "winter": true, "spring": true, "amber": true, "ruby": true,
	"violet": true, "iris": true, "ivy": true, "holly": true, "lily": true,
	"rose": true, "brook": true,
}

// FakeFirstNames is a pool of gender-neutral fake first names for replacement.
var FakeFirstNames = []string{
	"Alex", "Jordan", "Casey", "Taylor", "Morgan", "Riley", "Quinn", "Avery",
	"Dakota", "Skyler", "Jamie", "Parker", "Rowan", "Finley", "Sage", "Emery",
	"Hayden", "Reese", "Blair", "Drew", "Cameron", "Phoenix", "Remy", "Peyton",
	"Shea", "Robin", "Spencer", "Tatum", "Val", "Winter", "Arden", "Blake",
	"Charlie", "Devon", "Eden", "Frankie", "Gray", "Harley", "Indigo", "Jules",
	"Kai", "Lane", "Marley", "Noel", "Oakley", "Palmer", "Raven", "Sawyer",
}

// FakeLastNames is a pool of fake last names for replacement.
var FakeLastNames = []string{
	"Morgan", "Lee", "Rivera", "Chen", "Bailey", "Brooks", "Foster", "Hayes",
	"Kim", "Patel", "Cruz", "Diaz", "Ellis", "Grant", "Harper", "Huang",
	"Iyer", "James", "Kelly", "Lambert", "Mills", "Nash", "Ortiz", "Park",
	"Quinn", "Reed", "Singh", "Torres", "Voss", "Walsh", "Young", "Zhang",
	"Adler", "Burns", "Carter", "Drake", "Evans", "Flores", "Gomez", "Hart",
	"Jensen", "Khan", "Liu", "Moore", "Novak", "Price", "Russo", "Scott",
}

// fakeNamesLower is a precomputed set of all fake names (lowercase)
// to avoid re-replacing our own output.
var fakeNamesLower map[string]bool

func init() {
	fakeNamesLower = make(map[string]bool, len(FakeFirstNames)+len(FakeLastNames))
	for _, n := range FakeFirstNames {
		fakeNamesLower[strings.ToLower(n)] = true
	}
	for _, n := range FakeLastNames {
		fakeNamesLower[strings.ToLower(n)] = true
	}
}
