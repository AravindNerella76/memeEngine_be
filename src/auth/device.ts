/** "Chrome on Windows" from a User-Agent: enough for the owner to recognise their own device in a WhatsApp message. */
export function describeDevice(ua: unknown): string {
  const s = typeof ua === 'string' ? ua : '';
  const browser = /Edg(e|A|iOS)?\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /SamsungBrowser\//.test(s)
        ? 'Samsung Internet'
        : /CriOS\/|Chrome\//.test(s)
          ? 'Chrome'
          : /FxiOS\/|Firefox\//.test(s)
            ? 'Firefox'
            : /Safari\//.test(s)
              ? 'Safari'
              : 'A browser';
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? (/iPad/.test(s) ? 'iPad' : 'iPhone') : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
