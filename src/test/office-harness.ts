import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { word } from '../main/office/word';
import { excel } from '../main/office/excel';
import { unpack, pack, xml, readXml, putXml, elements, W, S, P, R, CT } from '../main/office/package';
import { runOffice } from '../main/office';
import { LocalFolderStore } from '../main/localFiles';
import { localFileTools } from '../main/ai/tools/localFiles';
import type { ToolContext } from '../main/ai/tools/types';
const fixture = (name:string) => fs.readFileSync(path.join(process.cwd(),'src/test/fixtures/office',name));
const output = process.env.NABSUN_OFFICE_OUTPUT;
function save(name:string, bytes:Uint8Array) { if(output){ fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),bytes); } }
function preserved(before:Uint8Array,after:Uint8Array,changed:string[]) {
  const a=unpack(before),b=unpack(after);assert.deepEqual(Object.keys(b).sort(),Object.keys(a).sort());
  for(const name of Object.keys(a))if(!changed.includes(name))assert.deepEqual(b[name],a[name],name+' must remain unchanged');
}
async function main(){
  const original=fixture('formatted.docx');
  const updated=word({kind:'word',action:'edit',replacements:[{oldText:'old value',newText:'new value'}],append:[{text:'Next steps',style:'heading1'},{text:'Prepare the final report.'}]},original).bytes!;
  preserved(original,updated,['word/document.xml']);
  const paragraphs=word({kind:'word',action:'read'},updated).value!.paragraphs;
  assert.ok(paragraphs.some(p=>p.text==='Status: new value'));assert.ok(paragraphs.some(p=>p.text==='Department'));
  assert.ok(paragraphs.some(p=>p.text==='Prepare the final report.'));
  const doc=readXml(unpack(updated),'word/document.xml');assert.equal(elements(doc,W,'tbl').length,1);assert.ok(elements(doc,W,'b').length);
  save('edited.docx',updated);
  const created=word({kind:'word',action:'create',paragraphs:[{text:'Project plan',style:'title'},{text:'Overview',style:'heading1'},{text:'Hello & welcome <everyone>\nSecond line.'}]}).bytes!;
  assert.equal(word({kind:'word',action:'read'},created).value!.paragraphs[2].text,'Hello & welcome <everyone>\nSecond line.');save('created.docx',created);
  const duplicate=word({kind:'word',action:'create',paragraphs:[{text:'same same'}]}).bytes!;
  assert.throws(()=>word({kind:'word',action:'edit',replacements:[{oldText:'same',newText:'new'}]},duplicate),/more than once/);
  assert.equal(word({kind:'word',action:'edit',replacements:[{oldText:'same',newText:'new',all:true}]},duplicate).summary!.textMatchesReplaced,2);
  const tracked=unpack(original),trackedDoc=readXml(tracked,'word/document.xml');const trackedParagraph=elements(trackedDoc,W,'p').find(p=>p.textContent?.includes('old value'))!;trackedParagraph.appendChild(trackedDoc.createElementNS(W,'w:fldChar'));putXml(tracked,'word/document.xml',trackedDoc);
  assert.throws(()=>word({kind:'word',action:'edit',replacements:[{oldText:'old value',newText:'bad'}]},pack(tracked)),/fields or tracked/);
  const protectedWord=unpack(original);protectedWord['word/settings.xml']=Buffer.from(`<w:settings xmlns:w="${W}"><w:documentProtection w:enforcement="1"/></w:settings>`);
  assert.throws(()=>word({kind:'word',action:'edit',append:[{text:'bad'}]},pack(protectedWord)),/protected/);
  const signed=unpack(original);signed['_xmlsignatures/sig1.xml']=Buffer.from('<signature/>');
  assert.throws(()=>word({kind:'word',action:'edit',append:[{text:'bad'}]},pack(signed)),/signed/);
  for (const tag of ['ins','sdt']) {
    const parts=unpack(original),document=readXml(parts,'word/document.xml');
    const paragraph=elements(document,W,'p').find(p=>p.textContent?.includes('old value'))!;
    const wrapper=document.createElementNS(W,'w:'+tag);paragraph.parentNode!.replaceChild(wrapper,paragraph);
    if(tag==='sdt'){const props=document.createElementNS(W,'w:sdtPr'),lock=document.createElementNS(W,'w:lock');lock.setAttributeNS(W,'w:val','contentLocked');props.appendChild(lock);wrapper.appendChild(props);const content=document.createElementNS(W,'w:sdtContent');wrapper.appendChild(content);content.appendChild(paragraph)}else wrapper.appendChild(paragraph);
    putXml(parts,'word/document.xml',document);
    assert.throws(()=>word({kind:'word',action:'edit',replacements:[{oldText:'old value',newText:'bad'}]},pack(parts)),/tracked changes|locked content control/);
  }
  console.log('PASS DOCX creation, split-format-run replacement, appending, unchanged package parts, ambiguity and protected/field/signed refusal');

  const book=fixture('formatted.xlsx');
  const edited=excel({kind:'excel',action:'edit',sheet:'Budget',changes:[{cell:'B2',value:8},{cell:'C2',value:4},{cell:'I12',value:'New note'}]},book).bytes!;
  preserved(book,edited,['xl/worksheets/sheet1.xml','xl/workbook.xml']);save('edited.xlsx',edited);
  const cells: {cell:string|null;value?:unknown;formula?:unknown;cacheMayBeStale?:boolean;style?:string}[]=excel({kind:'excel',action:'read',sheet:'Budget',range:'A1:I12'},edited).value!.cells;
  assert.equal(cells.find(c=>c.cell==='B2')!.value,8);assert.equal(cells.find(c=>c.cell==='D2')!.formula,'SUM(B2:C2)');
  assert.equal(cells.find(c=>c.cell==='D2')!.cacheMayBeStale,true);assert.ok(cells.find(c=>c.cell==='B2')!.style);
  for(const [sheet,cell,pattern] of [['Locked','A1',/protected/],['Budget','G10',/top-left/],['Budget','A6',/headers and totals/]] as const)
    assert.throws(()=>excel({kind:'excel',action:'edit',sheet,changes:[{cell,value:1}]},book),pattern);
  const newBook=excel({kind:'excel',action:'create',sheets:[{name:'Summary',rows:[['Item','Amount','Approved','Formula','Literal'],['Tea',5,true,{formula:'SUM(B2:B3)'},'=WEBSERVICE("https://example.com")'],['Coffee',3,false,null,'Text']]},{name:'Other sheet',rows:[['Hello']]}]}).bytes!;
  save('created.xlsx',newBook);
  const newCells: typeof cells=excel({kind:'excel',action:'read',sheet:'Summary'},newBook).value!.cells;
  assert.equal(newCells.find(c=>c.cell==='C2')!.value,true);assert.equal(newCells.find(c=>c.cell==='E2')!.value,'=WEBSERVICE("https://example.com")');
  assert.equal(newCells.find(c=>c.cell==='D2')!.formula,'SUM(B2:B3)');assert.equal(newCells.find(c=>c.cell==='D3')!.value,null);
  for(const formula of ['WEBSERVICE("https://example.com")','HYPERLINK("https://example.com")',"'Missing'!A1",'[evil.xlsx]Sheet!A1','cmd|evil!A1','SUM(A1', 'XFE1'])
    assert.throws(()=>excel({kind:'excel',action:'edit',sheet:'Summary',changes:[{cell:'B2',value:{formula}}]},newBook));
  const shared=unpack(book), sheet=readXml(shared,'xl/worksheets/sheet1.xml');
  const f=elements(sheet,S,'f')[0];f.setAttribute('t','array');f.setAttribute('ref','D2:D3');putXml(shared,'xl/worksheets/sheet1.xml',sheet);
  assert.throws(()=>excel({kind:'excel',action:'edit',sheet:'Budget',changes:[{cell:'D3',value:1}]},pack(shared)),/array/);
  const manual=unpack(book),wb=readXml(manual,'xl/workbook.xml');elements(wb,S,'calcPr')[0].setAttribute('calcMode','manual');putXml(manual,'xl/workbook.xml',wb);
  const rel=readXml(manual,'xl/_rels/workbook.xml.rels'),entry=rel.createElementNS(P,'Relationship');entry.setAttribute('Id','calc');entry.setAttribute('Type',R+'/calcChain');entry.setAttribute('Target','calcChain.xml');rel.documentElement!.appendChild(entry);putXml(manual,'xl/_rels/workbook.xml.rels',rel);
  const types=readXml(manual,'[Content_Types].xml'),type=types.createElementNS(CT,'Override');type.setAttribute('PartName','/xl/calcChain.xml');type.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml');types.documentElement!.appendChild(type);putXml(manual,'[Content_Types].xml',types);manual['xl/calcChain.xml']=Buffer.from(`<calcChain xmlns="${S}"><c r="D2" i="1"/></calcChain>`);
  const recalced=unpack(excel({kind:'excel',action:'edit',sheet:'Budget',changes:[{cell:'D2',value:12}]},pack(manual)).bytes!);
  assert.equal(recalced['xl/calcChain.xml'],undefined);assert.equal(elements(readXml(recalced,'xl/workbook.xml'),S,'calcPr')[0].getAttribute('calcMode'),'manual');
  console.log('PASS XLSX cell types, safe explicit formulas, styles/comments/charts/tables/other-sheet preservation, protected/merged/array/table refusal and calculation metadata');

  assert.throws(()=>unpack(zipSync({'../escape.xml':Buffer.from('bad')})),/Unsafe/);
  assert.throws(()=>unpack(zipSync({'a.xml':Buffer.from('a'),'A.xml':Buffer.from('b')})),/duplicate/);
  assert.throws(()=>unpack(zipSync({'large.xml':new Uint8Array(8*1024*1024+1)})),/oversized/);
  const corrupt=Buffer.from(created),central=corrupt.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));corrupt[central+16]^=1;assert.throws(()=>unpack(corrupt),/integrity/);
  assert.throws(()=>xml('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><foo>&x;</foo>'),/Unsafe/);
  const external=unpack(original);external['_rels/.rels']=Buffer.from(`<Relationships xmlns="${P}"><Relationship Id="main" Type="${R}/officeDocument" Target="https://example.com/x" TargetMode="External"/></Relationships>`);
  assert.throws(()=>word({kind:'word',action:'read'},pack(external)),/External/);
  const macro=unpack(original);macro['word/vbaProject.bin']=Buffer.from('macro');assert.throws(()=>word({kind:'word',action:'read'},pack(macro)),/Macro/);
  assert.throws(()=>word({kind:'word',action:'read'},Buffer.from('encrypted old office format')),/unencrypted/);
  const worker=await runOffice({kind:'word',action:'read'},Buffer.from(updated));assert.ok(worker.value);
  const stop=new AbortController();const pending=runOffice({kind:'excel',action:'read'},Buffer.from(edited),stop.signal);stop.abort();await assert.rejects(pending,/Stopped/);
  console.log('PASS bounded ZIP/XML, traversal/duplicates/corruption/macros/external relationship refusal, actual worker and cancellation');

  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nabsun-office-test-'));
  try {
    const store=new LocalFolderStore([]),grant=store.grant('chat',store.inspect(root),'read-write'),ro=store.grant('read',store.inspect(root),'read');
    const ctx={localFiles:store,fileScope:'chat',signal:new AbortController().signal} as ToolContext;
    const invoke=async(name:string,args:Record<string,unknown>,context=ctx)=>JSON.parse(await localFileTools().find(t=>t.name===name)!.handler(args,context) as string);
    const args={folderId:grant.id,path:'plan.docx',paragraphs:[{text:'Draft plan'}]};
    await invoke('local_word_create',args);await assert.rejects(invoke('local_word_create',args),/current hash|already exists/);
    const read=await invoke('local_office_read',{folderId:grant.id,path:'plan.docx'});
    const changed=await invoke('local_word_edit',{folderId:grant.id,path:'plan.docx',expectedHash:read.hash,replacements:[{oldText:'Draft',newText:'Final'}]});
    assert.ok(changed.backup);assert.equal(word({kind:'word',action:'read'},fs.readFileSync(path.join(root,changed.backup))).value!.paragraphs[0].text,'Draft plan');
    await assert.rejects(invoke('local_word_edit',{folderId:grant.id,path:'plan.docx',expectedHash:read.hash,append:[{text:'stale'}]}),/changed/);
    await assert.rejects(invoke('local_word_create',{...args,folderId:ro.id},{...ctx,fileScope:'read'}),/read-only/);
    await assert.rejects(invoke('local_word_create',{...args,path:'../escape.docx'}),/relative path|not allowed/);
    await invoke('local_excel_create',{folderId:grant.id,path:'budget.xlsx',sheets:[{name:'Budget',rows:[['Amount'],[5]]}]});
    const before=await invoke('local_office_read',{folderId:grant.id,path:'budget.xlsx',sheet:'Budget'});
    await invoke('local_excel_edit',{folderId:grant.id,path:'budget.xlsx',expectedHash:before.hash,sheet:'Budget',changes:[{cell:'A2',value:10}]});
    assert.equal((await invoke('local_office_read',{folderId:grant.id,path:'budget.xlsx',sheet:'Budget'})).cells.find((c:{cell:string})=>c.cell==='A2').value,10);
    const late=invoke('local_word_create',{...args,path:'revoked.docx'});store.revoke('chat',grant.id);await assert.rejects(late,/unavailable/);assert.equal(fs.existsSync(path.join(root,'revoked.docx')),false);
    store.clear();console.log('PASS Office tools with real workers, file permissions, revision conflicts, backups, no overwrite, traversal and mid-work revocation');
  } finally { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'nabsun-office-test-'));fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
