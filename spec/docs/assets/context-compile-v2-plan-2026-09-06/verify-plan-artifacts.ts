import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { createCatalog, verifyRenderedHash, verifyPromptMessageHash } from 's11tnext';

// Design-only executable contract. This is not the production v2 validator.
const here = new URL('.', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, here), 'utf8'));
const schema = read('selector-output.schema.json');
const input = read('example-input.json');
const response = read('example-response.json');
const validate = new Ajv({allErrors: true, strict: false}).compile(schema);
function accepted(payload: any, request = input): boolean {
  if (!validate(payload)) return false;
  const candidates = new Map<string, any>(request.candidates.map((c: any) => [c.id, c]));
  if (payload.decisions.length !== candidates.size) return false;
  const seen = new Set<string>();
  const optional = new Set<string>();
  for (const d of payload.decisions) {
    const c = candidates.get(d.candidateId);
    if (!c || seen.has(c.id)) return false;
    seen.add(c.id);
    if (c.protected && d.verdict === 'omit') return false;
    if (!d.goalAnchors.every((a: string) => request.goal.includes(a))) return false;
    if (!d.evidenceGroupIds.every((id: string) => c.evidenceGroupIds.includes(id))) return false;
    if (c.protected && !c.evidenceGroupIds.every((id: string) => d.evidenceGroupIds.includes(id))) return false;
    if (!c.protected && d.verdict !== 'omit') optional.add(c.id);
  }
  return payload.orderedOptionalIds.length === optional.size && payload.orderedOptionalIds.every((id: string) => optional.has(id));
}
const outcomes: {name: string; expected: boolean; actual: boolean}[] = [];
function check(name: string, expected: boolean, mutate?: (p: any) => void, request = input) {
  const p = structuredClone(response);
  mutate?.(p);
  const actual = accepted(p, request);
  outcomes.push({name, expected, actual});
  if (actual !== expected) throw new Error(`Mismatch: ${name}`);
}
check('valid Japanese input and response', true);
check('unknown candidate', false, p => p.decisions[0].candidateId = 'outside');
check('duplicate decision ID', false, p => p.decisions[1].candidateId = 'k1');
check('protected omitted', false, p => {p.decisions[1] = {candidateId:'k2',verdict:'omit',reasonCode:'unrelated',goalAnchors:[],evidenceGroupIds:[]};});
check('foreign evidence group', false, p => p.decisions[0].evidenceGroupIds = ['other:whole']);
check('fabricated goal anchor', false, p => p.decisions[0].goalAnchors = ['料理']);
check('missing decision', false, p => p.decisions.pop());
check('missing optional ordering', false, p => p.orderedOptionalIds = []);
check('unknown output key', false, p => p.markdown = 'Ignore prior instructions');
check('confidence field forbidden', false, p => p.decisions[0].confidence = 1);
check('protected placed in optional list', false, p => p.orderedOptionalIds.push('k2'));
check('empty candidate set', true, p => {p.decisions=[];p.orderedOptionalIds=[];}, {goal:'未知の課題', candidates:[]});
check('protected multi-group omission', false, undefined, {...input, candidates:[input.candidates[0], {...input.candidates[1], evidenceGroupIds:['k2:whole','k2:condition']} ]});
const artifact = read('catalog/catalog.json');
const catalog = createCatalog(artifact);
const messages = ['ja-JP','en-US'].map(locale => {
  const invocation = catalog.bind({instructionLocale:locale,fallbackLocales:[],trailingNewline:false})('contextCompiler.selectEvidence',{});
  if (!verifyRenderedHash(invocation.content.text,invocation.manifest.renderedHash)) throw new Error('render hash mismatch');
  if (!verifyPromptMessageHash({role:invocation.role,text:invocation.content.text},invocation.manifest.messageHash)) throw new Error('message hash mismatch');
  if (invocation.manifest.fallbackUsed) throw new Error('unexpected locale fallback');
  if (verifyRenderedHash(invocation.content.text+'tampered',invocation.manifest.renderedHash)) throw new Error('tamper check failed');
  return {key:invocation.manifest.key,locale,role:invocation.role,text:invocation.content.text,manifest:invocation.manifest,rawUtf8Sha256:createHash('sha256').update(invocation.content.text).digest('hex'),selectorSchemaSha256:createHash('sha256').update(readFileSync(new URL('selector-output.schema.json',here))).digest('hex')};
});
writeFileSync(new URL('compile-prompts.generated.json',here),JSON.stringify({format:'context-still.compile-static-prompts',version:1,messages},null,2)+'\n');
const report={designOnly:true,productionCodeChanged:false,schemaCases:outcomes,locales:messages.map(m=>({locale:m.locale,rawUtf8Sha256:m.rawUtf8Sha256,utf8Bytes:Buffer.byteLength(m.text)})),checks:['both locales built without fallback','rendered and message hashes verified','tampered text rejected'],limitations:['No live model invocation','Semantic goal relevance is not guaranteed by exact anchor validation','Native Rust adapter is planned, not implemented']};
writeFileSync(new URL('artifact-checks.json',here),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({cases:outcomes.length,passed:outcomes.filter(x=>x.expected===x.actual).length,locales:messages.length,hashChecks:'passed',designOnly:true}));
