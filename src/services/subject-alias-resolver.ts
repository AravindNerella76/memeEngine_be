export interface SubjectProfile {
  canonicalName: string;
  professionalName: string;
  aliases: string[];
  searchQueries: string[];
  verificationTokens: string[];
  isKnownEntity: boolean;
  category?: 'actor' | 'politician' | 'deity' | 'producer' | 'director' | 'general';
}

const KNOWN_SUBJECT_ENTITIES: SubjectProfile[] = [
  {
    canonicalName: 'Pawan Kalyan',
    professionalName: 'Konidela Pawan Kalyan',
    aliases: [
      'Anna Konidala',
      'Anna Konidela',
      'Konidala',
      'Konidela',
      'Power Star',
      'Power Star Pawan Kalyan',
      'Powerstar',
      'Kalyan Babu',
      'Konidela Kalyan Babu',
      'PK',
      'Janasenani',
      'Deputy CM Pawan Kalyan',
      'Pawan'
    ],
    searchQueries: [
      'Pawan Kalyan',
      'Konidela Pawan Kalyan',
      'Power Star Pawan Kalyan',
      'Shri Konidela Pawan Kalyan',
      'Pawan Kalyan portrait',
      'Pawan Kalyan movie still'
    ],
    verificationTokens: ['pawan', 'kalyan', 'konidela', 'konidala', 'powerstar'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'Thalapathy Vijay',
    professionalName: 'Joseph Vijay',
    aliases: [
      'Thalapathy',
      'Vijay',
      'C. Joseph Vijay',
      'Joseph Vijay',
      'Ilayathalapathy',
      'TVK Vijay',
      'Thalapathi'
    ],
    searchQueries: [
      'Thalapathy Vijay',
      'C. Joseph Vijay',
      'Vijay actor',
      'Thalapathy Vijay portrait',
      'Thalapathy Vijay movie still'
    ],
    verificationTokens: ['vijay', 'thalapathy', 'thalapathi', 'joseph'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'Jr NTR',
    professionalName: 'N. T. Rama Rao Jr.',
    aliases: [
      'Tarak',
      'Jr. NTR',
      'Young Tiger',
      'Young Tiger NTR',
      'Nandamuri Taraka Rama Rao Jr.',
      'NTR',
      'NTR Jr'
    ],
    searchQueries: [
      'N. T. Rama Rao Jr.',
      'Jr NTR',
      'N.T. Rama Rao Jr. portrait',
      'Jr NTR RRR',
      'Jr NTR movie still'
    ],
    verificationTokens: ['ntr', 'tarak', 'rama rao', 'nandamuri'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'N. Chandrababu Naidu',
    professionalName: 'Nara Chandrababu Naidu',
    aliases: [
      'CBN',
      'Chandrababu',
      'Chandrababu Naidu',
      'Nara Babu',
      'CM Chandrababu Naidu',
      'Babu Naidu'
    ],
    searchQueries: [
      'Nara Chandrababu Naidu',
      'N. Chandrababu Naidu',
      'CM Nara Chandrababu Naidu portrait'
    ],
    verificationTokens: ['chandrababu', 'naidu', 'cbn'],
    isKnownEntity: true,
    category: 'politician'
  },
  {
    canonicalName: 'A. Revanth Reddy',
    professionalName: 'Anumula Revanth Reddy',
    aliases: [
      'Revanth',
      'Revanth Reddy',
      'CM Revanth Reddy',
      'Telangana CM Revanth'
    ],
    searchQueries: [
      'A. Revanth Reddy',
      'Anumula Revanth Reddy',
      'Revanth Reddy Telangana portrait'
    ],
    verificationTokens: ['revanth', 'reddy'],
    isKnownEntity: true,
    category: 'politician'
  },
  {
    canonicalName: 'YS Jagan Mohan Reddy',
    professionalName: 'Y. S. Jagan Mohan Reddy',
    aliases: [
      'Jagan',
      'YS Jagan',
      'Jagan Mohan Reddy',
      'YSRCP Jagan'
    ],
    searchQueries: [
      'YS Jagan Mohan Reddy',
      'Y. S. Jagan Mohan Reddy',
      'Jagan Mohan Reddy portrait'
    ],
    verificationTokens: ['jagan', 'mohan reddy'],
    isKnownEntity: true,
    category: 'politician'
  },
  {
    canonicalName: 'Mamata Banerjee',
    professionalName: 'Mamata Banerjee',
    aliases: [
      'Didi',
      'Mamata Didi',
      'Mamta Banerjee',
      'Bengal CM Mamata'
    ],
    searchQueries: [
      'Mamata Banerjee',
      'Mamata Banerjee portrait'
    ],
    verificationTokens: ['mamata', 'banerjee'],
    isKnownEntity: true,
    category: 'politician'
  },
  {
    canonicalName: 'Chiranjeevi',
    professionalName: 'Konidela Siva Sankara Vara Prasad',
    aliases: [
      'Megastar',
      'Megastar Chiranjeevi',
      'Chiru',
      'Boss',
      'Mega Star',
      'Annayya'
    ],
    searchQueries: [
      'Chiranjeevi',
      'Megastar Chiranjeevi',
      'Konidela Chiranjeevi'
    ],
    verificationTokens: ['chiranjeevi', 'megastar', 'chiru'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'Ram Charan',
    professionalName: 'Konidela Ram Charan Teja',
    aliases: [
      'Mega Power Star',
      'Mega Power Star Ram Charan',
      'Cherry',
      'Ram Charan Teja'
    ],
    searchQueries: [
      'Ram Charan',
      'Konidela Ram Charan',
      'Mega Power Star Ram Charan'
    ],
    verificationTokens: ['charan', 'ram charan'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'Prabhas',
    professionalName: 'Uppalapati Venkata Suryanarayana Prabhas Raju',
    aliases: [
      'Rebel Star',
      'Rebel Star Prabhas',
      'Darling',
      'Darling Prabhas',
      'Prabhas Raju'
    ],
    searchQueries: [
      'Prabhas',
      'Rebel Star Prabhas',
      'Prabhas actor'
    ],
    verificationTokens: ['prabhas', 'darling'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'Mahesh Babu',
    professionalName: 'Ghattamaneni Mahesh Babu',
    aliases: [
      'Superstar',
      'Superstar Mahesh Babu',
      'Super Star Mahesh',
      'Prince',
      'Prince Mahesh'
    ],
    searchQueries: [
      'Mahesh Babu',
      'Superstar Mahesh Babu',
      'Ghattamaneni Mahesh Babu'
    ],
    verificationTokens: ['mahesh', 'babu'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'Allu Arjun',
    professionalName: 'Allu Arjun',
    aliases: [
      'Icon Star',
      'Icon Star Allu Arjun',
      'Stylish Star',
      'Bunny',
      'Pushpa Raj'
    ],
    searchQueries: [
      'Allu Arjun',
      'Icon Star Allu Arjun',
      'Allu Arjun Pushpa'
    ],
    verificationTokens: ['allu', 'arjun', 'bunny'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'Nani',
    professionalName: 'Ghanta Naveen Babu',
    aliases: [
      'Natural Star',
      'Natural Star Nani',
      'Naveen Babu'
    ],
    searchQueries: [
      'Natural Star Nani',
      'Nani actor',
      'Nani Telugu actor'
    ],
    verificationTokens: ['nani', 'natural star'],
    isKnownEntity: true,
    category: 'actor'
  },
  {
    canonicalName: 'Lord Vishnu',
    professionalName: 'Lord Vishnu',
    aliases: [
      'Venkateswara Swamy',
      'Tirupati Balaji',
      'Govinda',
      'Narayana',
      'Perumal',
      'Sri Venkateswara'
    ],
    searchQueries: [
      'Lord Vishnu',
      'Venkateswara Swamy Tirupati',
      'Lord Vishnu deity portrait'
    ],
    verificationTokens: ['vishnu', 'venkateswara', 'balaji', 'narayana', 'govinda'],
    isKnownEntity: true,
    category: 'deity'
  }
];

/**
 * Intelligently resolves any raw subject name (including Telugu/Tamil honorifics,
 * nicknames, and alternate spellings) into a structured profile with canonical
 * names and verification tokens.
 */
export function resolveSubjectIdentity(rawSubject: string, context?: string): SubjectProfile {
  const cleanInput = rawSubject.trim();
  const lowerInput = cleanInput.toLowerCase();

  // 1. Direct or alias match against known entities
  for (const entity of KNOWN_SUBJECT_ENTITIES) {
    if (entity.canonicalName.toLowerCase() === lowerInput ||
        entity.professionalName.toLowerCase() === lowerInput) {
      return entity;
    }
    for (const alias of entity.aliases) {
      if (alias.toLowerCase() === lowerInput) {
        return entity;
      }
    }
  }

  // 2. Fuzzy / keyword match against known entities
  // Handles compound forms like "Anna Konidala", "Power Star Anna", "Tarak Simhadri"
  for (const entity of KNOWN_SUBJECT_ENTITIES) {
    // Check if input matches primary tokens
    const primaryTokens = entity.canonicalName.toLowerCase().split(/\s+/);
    if (primaryTokens.every(tok => lowerInput.includes(tok))) {
      return entity;
    }

    // Check aliases
    for (const alias of entity.aliases) {
      const aliasLower = alias.toLowerCase();
      if (lowerInput.includes(aliasLower) || aliasLower.includes(lowerInput)) {
        return entity;
      }
    }
  }

  // 3. Honorific & Surname Decomposition:
  // e.g. "Anna Konidala" -> "Konidala" / "Konidela" -> resolves to Pawan Kalyan
  if (lowerInput.includes('konidala') || lowerInput.includes('konidela')) {
    const pk = KNOWN_SUBJECT_ENTITIES.find(e => e.canonicalName === 'Pawan Kalyan');
    if (pk) return pk;
  }
  if (lowerInput.includes('power') && lowerInput.includes('star')) {
    const pk = KNOWN_SUBJECT_ENTITIES.find(e => e.canonicalName === 'Pawan Kalyan');
    if (pk) return pk;
  }
  if (lowerInput.includes('thalapathy') || lowerInput.includes('thalapathi')) {
    const vj = KNOWN_SUBJECT_ENTITIES.find(e => e.canonicalName === 'Thalapathy Vijay');
    if (vj) return vj;
  }
  if (lowerInput.includes('tarak')) {
    const ntr = KNOWN_SUBJECT_ENTITIES.find(e => e.canonicalName === 'Jr NTR');
    if (ntr) return ntr;
  }

  // 4. Fallback for unlisted / unknown entities:
  // Strip common honorifics: "Anna", "Garu", "Babu", "Shri", "Dr", "Mr"
  const stripped = cleanInput
    .replace(/^(Anna|Shri|Sri|Mr|Ms|Dr|Chiru|Boss|CM|DCM)\s+/i, '')
    .replace(/\s+(Garu|Anna|Babu|Naidu|Reddy|Rao|Chowdary)$/i, '')
    .trim();

  const fallbackTokens = stripped
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !['entity', 'person', 'actor', 'image', 'photo', 'unknown', 'random'].includes(t));

  return {
    canonicalName: stripped || cleanInput,
    professionalName: cleanInput,
    aliases: [cleanInput, stripped].filter(Boolean),
    searchQueries: [cleanInput, stripped].filter(Boolean),
    verificationTokens: fallbackTokens,
    isKnownEntity: false,
    category: 'general'
  };
}

/**
 * Builds an array of distinct, prioritized search queries combining:
 * 1. Resolved canonical name
 * 2. Professional / official name
 * 3. Exact raw input name
 * 4. Popular nicknames / aliases
 * 5. Context-aware queries (e.g. subject + movie title or event)
 */
export function buildSubjectSearchQueries(
  rawSubject: string,
  context?: string,
  label?: string
): string[] {
  const profile = resolveSubjectIdentity(rawSubject, context);
  const queries = new Set<string>();

  // 1. Primary Canonical Name
  queries.add(profile.canonicalName);

  // 2. Professional / Full Name
  if (profile.professionalName && profile.professionalName !== profile.canonicalName) {
    queries.add(profile.professionalName);
  }

  // 3. Exact Raw Input (if distinct)
  if (rawSubject.trim() && rawSubject.trim() !== profile.canonicalName) {
    queries.add(rawSubject.trim());
  }

  // 4. Predefined high-yield search queries from knowledge base
  profile.searchQueries.forEach(q => queries.add(q));

  // 5. Contextual Query Augmentation (Movie title, event, or label)
  if (context && typeof context === 'string') {
    const cleanContext = context
      .replace(/viral|adaptation|meme|report|censor/gi, '')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .trim();

    const contextKeywords = cleanContext.split(/\s+/).filter(w => w.length >= 3 && !['movie', 'update', 'news'].includes(w.toLowerCase()));

    if (contextKeywords.length > 0) {
      const topKeyword = contextKeywords[0];
      // e.g. "Pawan Kalyan OG movie still"
      queries.add(`${profile.canonicalName} ${topKeyword} movie still`);
      queries.add(`${profile.canonicalName} ${topKeyword}`);
    }
  }

  if (label && typeof label === 'string' && label.length > 3) {
    const cleanLabel = label.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (cleanLabel.length > 3 && !cleanLabel.toLowerCase().includes(profile.canonicalName.toLowerCase())) {
      queries.add(`${profile.canonicalName} ${cleanLabel}`);
    }
  }

  return Array.from(queries);
}

/**
 * Returns all acceptable tokens that verify a candidate image actually depicts the subject.
 */
export function getSubjectVerificationTokens(rawSubject: string, profile?: SubjectProfile): string[] {
  const resolved = profile || resolveSubjectIdentity(rawSubject);
  const tokenSet = new Set<string>();

  // Add verification tokens from profile
  resolved.verificationTokens.forEach(t => tokenSet.add(t.toLowerCase()));

  // Add tokens from canonical and professional names (strictly alphabetic)
  const genericWords = new Set(['entity', 'person', 'actor', 'image', 'photo', 'unknown', 'random', 'update', 'movie', 'news']);

  resolved.canonicalName
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !genericWords.has(t))
    .forEach(t => tokenSet.add(t));

  resolved.professionalName
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !genericWords.has(t))
    .forEach(t => tokenSet.add(t));

  return Array.from(tokenSet);
}
