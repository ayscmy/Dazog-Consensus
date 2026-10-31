const P = {
  dash: '<rect x="2.5" y="2.5" width="5" height="5" rx="1.2"/><rect x="8.5" y="2.5" width="5" height="5" rx="1.2"/><rect x="2.5" y="8.5" width="5" height="5" rx="1.2"/><rect x="8.5" y="8.5" width="5" height="5" rx="1.2"/>',
  lead: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2"/><path d="M8 .8v2.2M8 13v2.2M.8 8h2.2M13 8h2.2"/>',
  account: '<path d="M2.5 13.5V4.2L8 1.8l5.5 2.4v9.3"/><path d="M1 13.5h14"/><path d="M6 6.2h1.2M8.8 6.2H10M6 8.6h1.2M8.8 8.6H10M6.4 13.5v-2.4h3.2v2.4"/>',
  opp: '<path d="M1.6 11.4 5.5 7.2l2.6 2.4 5.8-6.2"/><path d="M10.4 3.4h3.6v3.6"/>',
  quote: '<path d="M3.4 1.8h6l3.2 3.2v9.2H3.4z"/><path d="M9.2 1.8v3.4h3.4"/><path d="M5.4 8.4h5.2M5.4 10.8h3.4"/>',
  contract: '<path d="M3.4 1.8h6l3.2 3.2v9.2H3.4z"/><path d="M9.2 1.8v3.4h3.4"/><path d="M5.2 11.6c1-.9 1.7.6 2.6-.2s1.3.4 2.2-.2"/>',
  finance: '<rect x="1.6" y="3.6" width="12.8" height="8.8" rx="1.6"/><circle cx="8" cy="8" r="1.9"/><path d="M4.2 6.2v.02M11.8 9.8v.02"/>',
  approval: '<path d="M3 8.4l3.2 3.2L13 4.6"/>',
  report: '<path d="M2 13.4h12"/><path d="M4.2 13.4V8.2M7.2 13.4V4.6M10.2 13.4v-6M13.2 13.4V6.4"/>',
  admin: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>',
  search: '<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4 14 14"/>',
  bell: '<path d="M8 1.8a3.6 3.6 0 0 0-3.6 3.6c0 3.4-1.2 4.4-1.2 4.4h9.6s-1.2-1-1.2-4.4A3.6 3.6 0 0 0 8 1.8z"/><path d="M6.6 12.4a1.5 1.5 0 0 0 2.8 0"/>',
  plus: '<path d="M8 3.6v8.8M3.6 8h8.8"/>',
  close: '<path d="M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4"/>',
  chev: '<path d="M4 6.2 8 10l4-3.8"/>',
  filter: '<path d="M2.4 3.4h11.2L9.2 8.4v4.4l-2.4 1V8.4z"/>',
  more: '<circle cx="3.2" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.8" cy="8" r="1"/>',
  arrow: '<path d="M9.4 3.6 13.8 8l-4.4 4.4"/><path d="M13.4 8H2.6"/>',
  check: '<path d="M3 8.4l3 3 7-7"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  team: '<circle cx="5.6" cy="5.8" r="2.2"/><circle cx="11" cy="6.6" r="1.7"/><path d="M1.8 13.4c0-2.1 1.7-3.6 3.8-3.6s3.8 1.5 3.8 3.6"/><path d="M9.4 13.4c0-1.6 1-2.8 2.4-2.8 1.2 0 2.2.9 2.4 2.2"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
  building: '<path d="M3 13.5V2.5h10v11"/><path d="M2 13.5h12"/><path d="M6 5.4h1M9 5.4h1M6 8h1M9 8h1"/>',
  user: '<circle cx="8" cy="5.4" r="2.6"/><path d="M2.8 13.6c0-2.6 2.3-4.2 5.2-4.2s5.2 1.6 5.2 4.2"/>',
  logout: '<path d="M6.2 2.4H3v11.2h3.2"/><path d="M10 11l3-3-3-3"/><path d="M13 8H6.4"/>',
  warn: '<path d="M8 2.4 14.6 13.6H1.4z"/><path d="M8 6v3.2M8 11.6v.02"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6M8 5v.02"/>',
  drag: '<circle cx="6" cy="4" r=".7"/><circle cx="10" cy="4" r=".7"/><circle cx="6" cy="8" r=".7"/><circle cx="10" cy="8" r=".7"/><circle cx="6" cy="12" r=".7"/><circle cx="10" cy="12" r=".7"/>',
  product: '<path d="M8 1.8 14 5v6l-6 3.2L2 11V5z"/><path d="M2 5l6 3.2L14 5"/><path d="M8 8.2v6"/>',
  gear: '<circle cx="8" cy="8" r="2.4"/><path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"/>',
  clip: '<path d="M11.4 7.2 7.6 11a2.6 2.6 0 0 1-3.7-3.7l4.2-4.2a1.8 1.8 0 0 1 2.5 2.5L6.4 9.8a.9.9 0 0 1-1.3-1.3l3.8-3.8"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.6"/><circle cx="5.8" cy="6.4" r="1.1"/><path d="M2.4 11.4 6 8.4l2.4 2 2.2-1.8 3 2.8"/>',
  upload: '<path d="M8 11V2.8"/><path d="M4.6 6.2 8 2.8l3.4 3.4"/><path d="M2.6 11.4v2h10.8v-2"/>',
  trash: '<path d="M2.6 4.2h10.8"/><path d="M5.4 4.2V2.6h5.2v1.6"/><path d="M4 4.2l.7 9.2h6.6l.7-9.2"/>',
  download: '<path d="M8 2.4v8.2"/><path d="M4.6 7.2 8 10.6l3.4-3.4"/><path d="M2.6 12.4v1.2h10.8v-1.2"/>',
  file: '<path d="M3.6 1.8h5.2l3.6 3.6v8.8H3.6z"/><path d="M8.8 1.8v3.6h3.6"/>',
};

export function icon(name, size = 15, cls = '') {
  const d = P[name] || P.info;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}
