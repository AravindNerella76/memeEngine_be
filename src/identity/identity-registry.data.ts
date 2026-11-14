/**
 * Identity registry: hand-reviewed, VERIFIED facts only.
 *
 * How to add a person safely:
 *  1. aliases           -> names that identify this person on their own (full names, unique nicknames).
 *  2. ambiguousAliases  -> bare or shared names. They never resolve without context evidence.
 *  3. contextCues       -> film / party / event names that, in the reference text, prove which person a
 *                          bare name means.
 *  4. collisions        -> other people/things that share part of the name (penalised in image titles,
 *                          and they block context resolution).
 *  5. Run `npm test`: the registry tests check every entry automatically (each verified alias resolves,
 *     each ambiguous alias stays ambiguous without context, no collision resolves to the person, and no
 *     two people share a verified name after spelling normalisation).
 *
 * Spelling variants that differ only by doubled letters, w/v, or aspirated consonants (th/t, bh/b,
 * dh/d, kh/k, gh/g, sh/s) are matched automatically and do not need separate entries. Vowel changes
 * (Konidela/Konidala, Naidu/Nayudu) do.
 */

export interface KnownSubjectEntry {
  canonicalName: string;
  professionalName: string;
  /** Verified aliases: any of these (as a whole phrase) identifies this person on its own. */
  aliases: string[];
  /** Bare or shared names. Never resolve on their own; need context evidence. */
  ambiguousAliases: string[];
  /** Specific film / party / event terms: evidence in context, or corroboration of an ambiguous name in a title. */
  contextCues: string[];
  /** Commonly confused people or things. Presence in an image title penalises the match. */
  collisions: string[];
  searchQueries: string[];
  category: 'actor' | 'politician' | 'deity' | 'producer' | 'director' | 'general';
  /** If true, a single-word canonical name (e.g. "Nani") needs corroboration in the candidate text. */
  requiresCorroboration?: boolean;
  corroboration?: string[];
}

export interface CharacterEntry {
  character: string;
  /** canonicalName of the actor in KNOWN_SUBJECT_ENTITIES. */
  actor: string;
  film: string;
  filmAliases: string[];
  /** Character names unique enough to identify the actor without film context. */
  aliasesNoContext: string[];
  /** Character names that also mean other things (real people, deities): need the film named in context. */
  aliasesWithFilmContext: string[];
}

export const KNOWN_SUBJECT_ENTITIES: KnownSubjectEntry[] = [
  {
    canonicalName: 'Pawan Kalyan',
    professionalName: 'Konidela Pawan Kalyan',
    aliases: [
      'Anna Konidala', 'Anna Konidela',
      'Power Star Pawan Kalyan', 'Powerstar Pawan Kalyan',
      'Shri Konidela Pawan Kalyan', 'Konidela Kalyan Babu',
      'Janasenani', 'Deputy CM Pawan Kalyan', 'Deputy Chief Minister Pawan Kalyan',
      'పవన్ కళ్యాణ్', 'పవన్ కల్యాణ్', 'పవర్ స్టార్ పవన్ కళ్యాణ్'
    ],
    ambiguousAliases: ['Pawan', 'PK', 'Power Star', 'Powerstar', 'Kalyan Babu', 'Kalyan', 'Konidela', 'Konidala', 'పవన్', 'పవర్ స్టార్'],
    contextCues: [
      'janasena', 'jana sena', 'og', 'they call him og', 'hari hara veera mallu', 'hhvm', 'gabbar singh',
      'vakeel saab', 'bheemla nayak', 'agnyaathavaasi', 'attarintiki daredi', 'ustaad bhagat singh'
    ],
    collisions: [
      'pawan singh', 'pawan malhotra', 'pawan kumar', 'pawan khera', 'pawan chamling', 'pawan hans',
      'kalyan ram', 'nandamuri kalyan ram', 'kalyan jewellers', 'kalyan jewelers', 'kalyan silks',
      'kalyan dev', 'kalyan krishna', 'kalyan shankar', 'kalyan malik', 'kalyan singh'
    ],
    searchQueries: [
      'Pawan Kalyan', 'Konidela Pawan Kalyan', 'Power Star Pawan Kalyan',
      'Shri Konidela Pawan Kalyan', 'Pawan Kalyan portrait', 'Pawan Kalyan movie still'
    ],
    category: 'actor'
  },
  {
    canonicalName: 'Thalapathy Vijay',
    professionalName: 'Joseph Vijay',
    aliases: [
      'Thalapathy', 'Thalapathi Vijay', 'Vijay Thalapathy', 'C. Joseph Vijay', 'Joseph Vijay Chandrasekhar',
      'Ilayathalapathy', 'Ilayathalapathy Vijay', 'TVK Vijay', 'దళపతి విజయ్'
    ],
    ambiguousAliases: ['Vijay', 'Thalapathi', 'విజయ్'],
    contextCues: [
      'tvk', 'tamilaga vettri kazhagam', 'jana nayagan', 'varisu', 'bigil', 'mersal', 'kaththi', 'theri'
    ],
    collisions: [
      'vijay deverakonda', 'vijay devarakonda', 'vijay sethupathi', 'vijay sethupati', 'vijay mallya',
      'vijay antony', 'vijay yesudas', 'vijay babu', 'vijay varma', 'vijay raaz', 'vijay shankar',
      'vijay kumar', 'vijay amritraj', 'vijay chauhan', 'vijay prakash', 'vijay rupani', 'vijay hazare',
      'vijay tendulkar', 'vijay mishra', 'vijay vasanth'
    ],
    searchQueries: [
      'Thalapathy Vijay', 'C. Joseph Vijay', 'Vijay actor',
      'Thalapathy Vijay portrait', 'Thalapathy Vijay movie still'
    ],
    category: 'actor'
  },
  {
    canonicalName: 'Jr NTR',
    professionalName: 'N. T. Rama Rao Jr.',
    aliases: [
      'Jr. NTR', 'NTR Jr', 'Young Tiger', 'Young Tiger NTR', 'Tarak', 'Nandamuri Tarak',
      'Nandamuri Taraka Rama Rao Jr.', 'NT Rama Rao Jr', 'Junior NTR',
      'జూనియర్ ఎన్టీఆర్', 'తారక్', 'యంగ్ టైగర్ ఎన్టీఆర్'
    ],
    ambiguousAliases: ['NTR', 'ఎన్టీఆర్'],
    contextCues: [
      'devara', 'simhadri', 'war 2', 'aravinda sametha', 'janatha garage', 'yamadonga', 'adhurs',
      'nannaku prematho', 'brindavanam', 'jai lava kusa', 'andhrawala'
    ],
    collisions: [
      'sr ntr', 'ntr sr', 'senior ntr', 'n t rama rao', 'nt rama rao', 'nandamuri taraka rama rao',
      'ntr arts', 'ntr trust', 'ntr stadium', 'ntr gardens', 'ntr bhavan', 'ntr nagar'
    ],
    searchQueries: [
      'N. T. Rama Rao Jr.', 'Jr NTR', 'N.T. Rama Rao Jr. portrait', 'Jr NTR RRR', 'Jr NTR movie still'
    ],
    category: 'actor'
  },
  {
    canonicalName: 'N. Chandrababu Naidu',
    professionalName: 'Nara Chandrababu Naidu',
    aliases: [
      'Chandrababu Naidu', 'Chandrababu', 'CBN', 'Nara Chandrababu', 'CM Chandrababu Naidu',
      'Chief Minister Chandrababu Naidu', 'చంద్రబాబు నాయుడు', 'చంద్రబాబు', 'నారా చంద్రబాబు నాయుడు'
    ],
    ambiguousAliases: ['Naidu', 'Babu Naidu', 'Nara Babu'],
    contextCues: ['tdp', 'telugu desam', 'telugu desam party', 'amaravati'],
    collisions: [
      'nara lokesh', 'venkaiah naidu', 'sarojini naidu', 'nara rohit', 'ram mohan naidu',
      'atchannaidu', 'nara bhuvaneswari'
    ],
    searchQueries: ['Nara Chandrababu Naidu', 'N. Chandrababu Naidu', 'CM Nara Chandrababu Naidu portrait'],
    category: 'politician'
  },
  {
    canonicalName: 'A. Revanth Reddy',
    professionalName: 'Anumula Revanth Reddy',
    aliases: [
      'Revanth Reddy', 'CM Revanth Reddy', 'Chief Minister Revanth Reddy',
      'Telangana CM Revanth Reddy', 'Telangana CM Revanth', 'రేవంత్ రెడ్డి'
    ],
    ambiguousAliases: ['Revanth', 'రేవంత్'],
    contextCues: ['tpcc', 'kodangal', 'telangana cm', 'telangana chief minister'],
    collisions: ['g kishan reddy', 'kishan reddy', 'kiran kumar reddy'],
    searchQueries: ['A. Revanth Reddy', 'Anumula Revanth Reddy', 'Revanth Reddy Telangana portrait'],
    category: 'politician'
  },
  {
    canonicalName: 'YS Jagan Mohan Reddy',
    professionalName: 'Y. S. Jagan Mohan Reddy',
    aliases: ['YS Jagan', 'Jagan Mohan Reddy', 'YS Jagan Reddy', 'YSRCP Jagan', 'జగన్ మోహన్ రెడ్డి', 'వైఎస్ జగన్'],
    ambiguousAliases: ['Jagan', 'జగన్'],
    contextCues: ['ysrcp', 'ycp', 'navaratnalu'],
    collisions: [
      'ys rajasekhara reddy', 'y s rajasekhara reddy', 'ys sharmila', 'ys vijayamma',
      'ys avinash reddy', 'ys bharathi'
    ],
    searchQueries: ['YS Jagan Mohan Reddy', 'Y. S. Jagan Mohan Reddy', 'Jagan Mohan Reddy portrait'],
    category: 'politician'
  },
  {
    canonicalName: 'Mamata Banerjee',
    professionalName: 'Mamata Banerjee',
    aliases: [
      'Mamta Banerjee', 'Mamata Didi', 'Mamta Didi', 'Bengal CM Mamata',
      'West Bengal CM Mamata Banerjee', 'Chief Minister Mamata Banerjee', 'మమతా బెనర్జీ'
    ],
    ambiguousAliases: ['Didi'],
    contextCues: ['tmc', 'trinamool', 'trinamool congress', 'nabanna'],
    collisions: ['abhishek banerjee', 'mamta kulkarni', 'mamata kulkarni', 'mamta sharma'],
    searchQueries: ['Mamata Banerjee', 'Mamata Banerjee portrait'],
    category: 'politician'
  },
  {
    canonicalName: 'Chiranjeevi',
    professionalName: 'Konidela Siva Sankara Vara Prasad',
    aliases: [
      'Megastar Chiranjeevi', 'Mega Star Chiranjeevi', 'Konidela Chiranjeevi', 'Chiranjeevi Konidela',
      'Padma Vibhushan Chiranjeevi', 'Chiru', 'చిరంజీవి', 'మెగాస్టార్ చిరంజీవి', 'చిరు'
    ],
    ambiguousAliases: ['Boss', 'Megastar', 'Mega Star', 'Annayya', 'Konidela', 'Konidala', 'మెగాస్టార్'],
    contextCues: [
      'bhola shankar', 'waltair veerayya', 'vishwambhara', 'sye raa', 'khaidi no 150',
      'mana shankara vara prasad garu', 'godfather'
    ],
    collisions: ['chiranjeevi sarja', 'chiru sarja', 'sarja chiranjeevi'],
    searchQueries: ['Chiranjeevi', 'Megastar Chiranjeevi', 'Konidela Chiranjeevi'],
    category: 'actor'
  },
  {
    canonicalName: 'Ram Charan',
    professionalName: 'Konidela Ram Charan Teja',
    aliases: [
      'Konidela Ram Charan', 'Ram Charan Teja', 'Mega Power Star', 'Mega Power Star Ram Charan',
      'Mega Powerstar Ram Charan', 'Global Star Ram Charan', 'రామ్ చరణ్'
    ],
    ambiguousAliases: ['Ram', 'Charan', 'Cherry', 'Konidela', 'Konidala'],
    contextCues: ['game changer', 'rangasthalam', 'magadheera', 'vinaya vidheya rama', 'peddi', 'dhruva'],
    collisions: ['ram pothineni', 'ram gopal varma', 'ram kapoor', 'ram mohan naidu'],
    searchQueries: ['Ram Charan', 'Konidela Ram Charan', 'Mega Power Star Ram Charan'],
    category: 'actor'
  },
  {
    canonicalName: 'Prabhas',
    professionalName: 'Uppalapati Venkata Suryanarayana Prabhas Raju',
    aliases: ['Rebel Star Prabhas', 'Darling Prabhas', 'Prabhas Raju', 'ప్రభాస్'],
    ambiguousAliases: ['Rebel Star', 'Darling'],
    contextCues: [
      'baahubali', 'salaar', 'kalki 2898 ad', 'kalki', 'adipurush', 'saaho', 'radhe shyam', 'raja saab'
    ],
    collisions: ['krishnam raju', 'krishnamraju', 'rebel star krishnam raju'],
    searchQueries: ['Prabhas', 'Rebel Star Prabhas', 'Prabhas actor'],
    category: 'actor'
  },
  {
    canonicalName: 'Mahesh Babu',
    professionalName: 'Ghattamaneni Mahesh Babu',
    aliases: [
      'Superstar Mahesh Babu', 'Super Star Mahesh Babu', 'Superstar Mahesh', 'Super Star Mahesh',
      'Prince Mahesh', 'Prince Mahesh Babu', 'Ghattamaneni Mahesh', 'మహేష్ బాబు'
    ],
    ambiguousAliases: ['Mahesh', 'Superstar', 'Super Star', 'Prince'],
    contextCues: [
      'guntur kaaram', 'sarkaru vaari paata', 'srimanthudu', 'bharat ane nenu', 'maharshi',
      'sarileru neekevvaru', 'pokiri', 'okkadu', 'athadu', 'dookudu', 'ssmb29', 'varanasi'
    ],
    collisions: [
      'mahesh bhatt', 'mahesh manjrekar', 'mahesh bhupathi', 'mahesh kothare',
      'superstar krishna', 'super star krishna', 'superstar rajinikanth', 'superstar rajini',
      'super star rajinikanth'
    ],
    searchQueries: ['Mahesh Babu', 'Superstar Mahesh Babu', 'Ghattamaneni Mahesh Babu'],
    category: 'actor'
  },
  {
    canonicalName: 'Allu Arjun',
    professionalName: 'Allu Arjun',
    aliases: ['Icon Star', 'Icon Star Allu Arjun', 'Stylish Star', 'Stylish Star Allu Arjun', 'Pushpa Raj', 'అల్లు అర్జున్'],
    ambiguousAliases: ['Bunny', 'Arjun', 'Allu', 'బన్నీ'],
    contextCues: ['pushpa', 'ala vaikunthapurramuloo', 'sarrainodu', 'race gurram', 'duvvada jagannadham'],
    collisions: [
      'allu sirish', 'allu aravind', 'allu ramalingaiah', 'allu bobby', 'arjun kapoor', 'arjun sarja',
      'arjun reddy', 'arjun tendulkar', 'arjun rampal'
    ],
    searchQueries: ['Allu Arjun', 'Icon Star Allu Arjun', 'Allu Arjun Pushpa'],
    category: 'actor'
  },
  {
    canonicalName: 'Nani',
    professionalName: 'Ghanta Naveen Babu',
    aliases: ['Natural Star', 'Natural Star Nani', 'నాని', 'నేచురల్ స్టార్ నాని'],
    ambiguousAliases: ['Naveen Babu'],
    contextCues: [
      'jersey', 'eega', 'dasara', 'hi nanna', 'saripodhaa sanivaaram', 'hit 3', 'shyam singha roy',
      'ante sundaraniki'
    ],
    collisions: ['nani palkhivala'],
    searchQueries: ['Natural Star Nani', 'Nani actor', 'Nani Telugu actor'],
    category: 'actor',
    // "Nani" is also a common word (grandmother in Hindi) and given name: require corroboration in image titles.
    requiresCorroboration: true,
    corroboration: ['actor', 'telugu', 'tollywood', 'film', 'movie', 'natural star']
  },
  {
    canonicalName: 'Lord Vishnu',
    professionalName: 'Lord Vishnu',
    aliases: [
      'Maha Vishnu', 'Sri Maha Vishnu', 'Bhagwan Vishnu', 'Vishnu Bhagavan',
      'Lord Venkateswara', 'Venkateswara Swamy', 'Sri Venkateswara', 'Sri Venkateswara Swamy',
      'Tirupati Balaji', 'Lord Balaji', 'శ్రీ మహావిష్ణువు', 'వెంకటేశ్వర స్వామి', 'వేంకటేశ్వర స్వామి'
    ],
    // "Sri Vishnu" is also the Telugu actor Sree Vishnu, so it is ambiguous, not verified.
    ambiguousAliases: ['Vishnu', 'Sri Vishnu', 'Govinda', 'Narayana', 'Perumal', 'Balaji', 'Venkateswara', 'విష్ణువు'],
    contextCues: [
      'vaikuntam', 'vaikuntha', 'dashavatar', 'dashavataram', 'narasimha', 'govardhan', 'govardan',
      'tirumala', 'tirupati', 'shesha', 'sudarshana'
    ],
    collisions: [
      'manchu vishnu', 'vishnu manchu', 'vishnuvardhan', 'vishnu vardhan', 'vishnu vishal',
      'vishnu priya', 'vishnu unnikrishnan', 'govinda ahuja', 'sree vishnu actor', 'actor sree vishnu'
    ],
    searchQueries: ['Lord Vishnu', 'Venkateswara Swamy Tirupati', 'Lord Vishnu deity portrait'],
    category: 'deity'
  }
];

/**
 * Film characters mapped to the actors who played them. Only well-known, unambiguous facts.
 * Names that also refer to real people or deities require the film to be named in the reference.
 */
export const CHARACTER_ENTRIES: CharacterEntry[] = [
  {
    character: 'Ojas Gambheera',
    actor: 'Pawan Kalyan',
    film: 'They Call Him OG',
    filmAliases: ['They Call Him OG', 'OG'],
    aliasesNoContext: ['Ojas Gambheera'],
    aliasesWithFilmContext: ['Ojas']
  },
  {
    character: 'Komaram Bheem',
    actor: 'Jr NTR',
    film: 'RRR',
    filmAliases: ['RRR'],
    aliasesNoContext: [],
    aliasesWithFilmContext: ['Komaram Bheem', 'Bheem'] // also a real tribal leader
  },
  {
    character: 'Alluri Sitarama Raju',
    actor: 'Ram Charan',
    film: 'RRR',
    filmAliases: ['RRR'],
    aliasesNoContext: [],
    aliasesWithFilmContext: ['Alluri Sitarama Raju', 'Alluri'] // also a real freedom fighter
  },
  {
    character: 'Baahubali',
    actor: 'Prabhas',
    film: 'Baahubali',
    filmAliases: ['Baahubali', 'Bahubali', 'Baahubali 2', 'Baahubali The Beginning', 'Baahubali The Conclusion'],
    aliasesNoContext: ['Amarendra Baahubali', 'Mahendra Baahubali', 'Amarendra Bahubali', 'Mahendra Bahubali'],
    aliasesWithFilmContext: ['Shivudu']
  },
  {
    character: 'Bhairava',
    actor: 'Prabhas',
    film: 'Kalki 2898 AD',
    filmAliases: ['Kalki 2898 AD', 'Kalki'],
    aliasesNoContext: [],
    aliasesWithFilmContext: ['Bhairava'] // also a form of Shiva
  },
  {
    character: 'Deva',
    actor: 'Prabhas',
    film: 'Salaar',
    filmAliases: ['Salaar', 'Salaar Part 1', 'Salaar Ceasefire'],
    aliasesNoContext: [],
    aliasesWithFilmContext: ['Deva', 'Salaar']
  },
  {
    character: 'Devara',
    actor: 'Jr NTR',
    film: 'Devara',
    filmAliases: ['Devara', 'Devara Part 1'],
    aliasesNoContext: [],
    aliasesWithFilmContext: ['Devara', 'Vara']
  },
  {
    character: 'Leo Das',
    actor: 'Thalapathy Vijay',
    film: 'Leo',
    filmAliases: ['Leo'],
    aliasesNoContext: ['Leo Das'],
    aliasesWithFilmContext: ['Parthiban', 'Parthi'] // R. Parthiban is also an actor
  }
];
