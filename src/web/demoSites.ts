// Sites for demoing the iframe feature. They are fixed in the UI (not stored in the database): click one in the
// sidebar and it opens in the single "Website demo" tab; click another and the same tab switches to it.
export interface DemoSite { name: string; url: string }

export const DEMO_SITES: DemoSite[] = [
  { name: 'Example Domain', url: 'https://example.com' },
  { name: 'Example Domain (org)', url: 'https://example.org' },
  { name: 'Wikipedia home', url: 'https://www.wikipedia.org' },
  { name: 'Wikipedia article', url: 'https://en.wikipedia.org/wiki/Iframe' },
  { name: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/' },
  { name: 'Wikimedia', url: 'https://www.wikimedia.org/' },
  { name: 'First website (CERN)', url: 'https://info.cern.ch/' },
  { name: 'Original WWW project page', url: 'http://info.cern.ch/hypertext/WWW/TheProject.html' },
  { name: 'Internet Archive', url: 'https://archive.org/' },
  { name: 'Project Gutenberg', url: 'https://www.gutenberg.org/' },
  { name: 'Python docs', url: 'https://docs.python.org/3/' },
  { name: 'SQLite', url: 'https://www.sqlite.org/' },
  { name: 'React docs', url: 'https://react.dev/' },
  { name: 'RFC Editor', url: 'https://www.rfc-editor.org/' },
  { name: 'xkcd', url: 'https://xkcd.com/' },
  { name: 'Lorem Ipsum generator', url: 'https://www.lipsum.com/' },
  { name: 'Minimal text-only page', url: 'https://motherfuckingwebsite.com/' },
  { name: 'JSONPlaceholder', url: 'https://jsonplaceholder.typicode.com/' },
  { name: 'OpenStreetMap embed', url: 'https://www.openstreetmap.org/export/embed.html' },
];
