export const categories = [
  ['clothing', '服装'], ['face', '顔立ち'], ['hair', '髪型'], ['pose', '体型・ポーズ'],
  ['background', '背景'], ['color', '色味'], ['camera', '撮影'], ['lighting', '光'], ['style', '画風'], ['other', 'その他'],
];
export const referenceRoles = [['overall', '全体'], ['person', '人物'], ['face', '顔立ち'], ['hair', '髪型'], ['clothing', '服装'], ['pose', 'ポーズ'], ['background', '背景'], ['color', '色味'], ['composition', '構図'], ['style', '画風']];
export const categoryLabel = id => categories.find(entry => entry[0] === id)?.[1] || 'その他';
export const roleLabel = id => referenceRoles.find(entry => entry[0] === id)?.[1] || '全体';
export function composePrompt(base, layers = []) {
  return [base.trim(), ...layers.map(layer => `【${categoryLabel(layer.category)}】\n${layer.body.trim()}`)].filter(Boolean).join('\n\n');
}
export function searchTemplates(templates, { query = '', category = '', favorite = false, archived = false } = {}) {
  const normalize = text => String(text).normalize('NFKC').toLocaleLowerCase('ja-JP');
  const terms = normalize(query).split(/\s+/).filter(Boolean).map(term => term.replace(/^#/, ''));
  return templates.filter(template => (archived ? Boolean(template.archivedAt) : !template.archivedAt)
    && (!category || template.category === category) && (!favorite || template.favorite)
    && terms.every(term => normalize([template.name, categoryLabel(template.category), template.body, ...template.tags].join(' ')).includes(term)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt));
}
