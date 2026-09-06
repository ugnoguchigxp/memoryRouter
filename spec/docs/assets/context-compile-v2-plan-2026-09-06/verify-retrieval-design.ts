import {Database} from 'bun:sqlite';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
// SQL feasibility probe only: not the v2 ranker or migration implementation.
const db=new Database(':memory:');
db.exec(`CREATE TABLE k(id TEXT PRIMARY KEY,title TEXT,body TEXT,project TEXT,status TEXT,classification TEXT);
CREATE VIRTUAL TABLE compile_fts USING fts5(id UNINDEXED,title,body,tokenize='trigram');
CREATE TRIGGER k_ai AFTER INSERT ON k BEGIN INSERT INTO compile_fts(id,title,body) VALUES(new.id,new.title,new.body); END;
CREATE TRIGGER k_au AFTER UPDATE ON k BEGIN DELETE FROM compile_fts WHERE id=old.id; INSERT INTO compile_fts(id,title,body) VALUES(new.id,new.title,new.body); END;
CREATE TRIGGER k_ad AFTER DELETE ON k BEGIN DELETE FROM compile_fts WHERE id=old.id; END;`);
const insert=db.prepare('INSERT INTO k VALUES (?,?,?,?,?,?)');
for(let i=0;i<500;i++) insert.run(`noise${i}`,'保存期間','バックアップの保存期間を変更する','other','active','classified');
insert.run('correct','バックアップ運用','バックアップの保存期間は30日です。','ours','active','classified');
insert.run('unresolved','保存期間','バックアップの保存期間を変更する','ours','active','unresolved');
const quote=(x:string)=>`"${x.replaceAll('"','""')}"`;
const goal='バックアップの保存期間を変更する';
const chars=[...goal];
const query=[...new Set(chars.slice(0,-2).map((_,i)=>chars.slice(i,i+3).join('')))].map(quote).join(' OR ');
const stmt=db.prepare(`SELECT k.id FROM compile_fts JOIN k ON k.id=compile_fts.id
WHERE compile_fts MATCH ? AND k.project=? AND k.status='active' AND k.classification='classified'
ORDER BY bm25(compile_fts),k.id LIMIT ?`);
const result=stmt.all(query,'ours',1) as {id:string}[];
assert.deepEqual(result.map(x=>x.id),['correct']);
const short=db.prepare('SELECT id FROM k WHERE project=? AND status=? AND classification=? AND instr(body,?)>0 ORDER BY id').all('ours','active','classified','保存') as {id:string}[];
assert.deepEqual(short.map(x=>x.id),['correct']);
assert.deepEqual(stmt.all(quote('" OR * NOT '),'ours',1),[]);
db.prepare('UPDATE k SET body=? WHERE id=?').run('復元条件は別途確認。','correct');
assert.deepEqual(stmt.all(quote('保存期間'),'ours',1),[]);
db.prepare('DELETE FROM k WHERE id=?').run('correct');
assert.deepEqual(db.prepare('SELECT id FROM compile_fts WHERE id=?').all('correct'),[]);
const report={designOnly:true,sqliteVersion:(db.query('select sqlite_version() as v').get() as any).v,checks:['Japanese trigram recall','scope and classification before LIMIT with 500 distractors','two-character literal fallback','FTS syntax treated as literal','update trigger removes old index content','delete trigger removes index content'],passed:6,limitations:['Bun SQLite in-memory; Rust bundled SQLite capability still requires U0 test','No full ranking/recall benchmark','No online migration or concurrency benchmark']};
writeFileSync(new URL('retrieval-probe.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));db.close();
