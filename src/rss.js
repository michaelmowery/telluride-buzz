// Minimal RSS 2.0 / Atom parser. No dependencies; tolerant of the CivicPlus and
// WordPress feeds the pilot uses. Not a general XML parser.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function unwrap(s) {
  if (s == null) return null;
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decodeEntities(s);
}

/** Strip HTML to plain text for summaries. */
export function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function tag(block, name) {
  // name may include a namespace prefix, e.g. "calendarEvent:EventDates"
  const re = new RegExp(`<${name.replace(/[:.]/g, '\\$&')}(?:\\s[^>]*)?>([\\s\\S]*?)</${name.replace(/[:.]/g, '\\$&')}>`, 'i');
  const m = block.match(re);
  return m ? unwrap(m[1]).trim() : null;
}

function attr(block, name, attrName) {
  const re = new RegExp(`<${name}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : null;
}

export function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = htmlToText(tag(b, 'title') || '');
    const link = isAtom
      ? attr(b, 'link', 'href')
      : tag(b, 'link') || attr(b, 'link', 'href') || tag(b, 'guid');
    const guid = tag(b, isAtom ? 'id' : 'guid') || link || title;
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const descHtml = tag(b, 'content:encoded') || tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || '';
    items.push({
      guid,
      title,
      link: link ? link.trim() : null,
      publishedAt: parseDate(date),
      summary: htmlToText(descHtml),
      // CivicPlus calendar feeds carry event times in their own namespace.
      eventDates: tag(b, 'calendarEvent:EventDates'),
      eventTimes: tag(b, 'calendarEvent:EventTimes'),
      eventLocation: tag(b, 'calendarEvent:Location'),
      categories: (b.match(/<category[^>]*>([\s\S]*?)<\/category>/gi) || []).map((c) => htmlToText(unwrap(c.replace(/<\/?category[^>]*>/gi, '')))),
    });
  }
  return items;
}

export function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
}
