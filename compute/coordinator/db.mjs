// Coordinator storage: SQLite (WAL, single writer = the coordinator process) + migrations.
// Keep the DB on a local disk: SQLite WAL is not safe on SMB/network shares (spec §3).
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
export const SCHEMA_VERSION=3;
const MIGRATIONS=[
`create table meta(key text primary key, value text not null);
create table devices(id text primary key, public_key text not null unique, alias text not null, state text not null,
  role text not null default 'worker', created_at integer not null, approved_at integer, revoked_at integer, revoke_reason text,
  capabilities text, runtime_version text, last_heartbeat integer, session_id text, session_started integer,
  status text, metrics text, accepted_count integer not null default 0, last_accepted_at integer);
create table pairing_codes(id text primary key, code_hash text not null, alias_hint text, created_at integer not null,
  expires_at integer not null, attempts integer not null default 0, used_at integer, device_id text);
create table nonces(nonce text primary key, device_id text not null, expires_at integer not null);
create table artifacts(sha256 text primary key, kind text not null, bytes integer not null, created_at integer not null);
create table model_variants(profile_id text not null, variant_id text not null, files_digest text, provenance text not null,
  manifest text not null, updated_at integer not null, primary key(profile_id,variant_id));
create table datasets(id text primary key, manifest text not null, manifest_hash text not null, created_at integer not null);
create table experiments(id text primary key, run_id text not null unique, name text not null, config text not null,
  config_hash text not null, state text not null, created_at integer not null, started_at integer, finished_at integer,
  initial_hash text, frozen_a_hash text, current_round integer not null default 0, blocker text, eval text);
create table rounds(experiment_id text not null, idx integer not null, attempt integer not null, state text not null,
  parent_hash text not null, opened_at integer not null, deadline_at integer not null, sealed_at integer, committed_at integer,
  checkpoint_hash text, accepted text, excluded text, blocker text, aggregation_ms integer, eval text,
  primary key(experiment_id,idx,attempt));
create table assignments(id text primary key, experiment_id text not null, round_idx integer not null, round_attempt integer not null,
  slot integer not null, rows_sha text not null, row_ids text not null, expected_tokens integer not null, mask_checksum text not null,
  state text not null, unique(experiment_id,round_idx,round_attempt,slot));
create table tasks(task_id text primary key, lease_id text not null unique, attempt integer not null, assignment_id text not null,
  device_id text not null, state text not null, leased_at integer not null, lease_expires_at integer not null, renewed_at integer,
  progress text, reason text, manifest text not null, unique(assignment_id,attempt));
create table updates(update_id text primary key, idempotency_key text not null unique, task_id text not null, device_id text not null,
  payload_sha text not null, bytes integer not null, state text not null, reason text, meta text not null,
  created_at integer not null, accepted_at integer, norm real, delta_norm real);
create unique index one_accepted_update_per_task on updates(task_id) where state='accepted';
create table checkpoints(hash text primary key, experiment_id text not null, round_idx integer not null, created_at integer not null, lineage text not null);
create table events(seq integer primary key autoincrement, ts integer not null, severity text not null, code text not null,
  experiment_id text, device_id text, task_id text, details text);
create table audit_log(id integer primary key autoincrement, ts integer not null, actor text not null, action text not null, details text);`,
`alter table experiments add column model_snapshot text;
alter table checkpoints rename to checkpoints_v1;
create table checkpoints(hash text not null, experiment_id text not null, round_idx integer not null, created_at integer not null, lineage text not null,
  primary key(experiment_id,round_idx));
insert into checkpoints select hash,experiment_id,round_idx,created_at,lineage from checkpoints_v1;
insert or ignore into checkpoints
  select initial_hash,id,0,coalesce(started_at,created_at),json_object('parent',null,'kind','canonical_init','seed',json_extract(config,'$.seed'))
  from experiments where initial_hash is not null;
insert or ignore into checkpoints
  select checkpoint_hash,experiment_id,idx+1,coalesce(committed_at,opened_at),json_object('parent',parent_hash,'round',idx,'attempt',attempt)
  from rounds where state='COMMITTED' and checkpoint_hash is not null;
drop table checkpoints_v1;`,
`create table upload_sessions(update_id text primary key, device_id text not null, chunk_bytes integer not null, expires_at integer not null);
create table upload_chunks(update_id text not null, idx integer not null, digest text not null, data blob not null, primary key(update_id,idx));
create table round_reuse(assignment_id text primary key, update_id text not null);`
];
export function openDB(file){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new DatabaseSync(file);
  db.exec('pragma journal_mode=wal; pragma synchronous=full; pragma foreign_keys=on; pragma busy_timeout=5000;');
  db.exec('create table if not exists meta(key text primary key, value text not null)');
  const row=db.prepare("select value from meta where key='schema_version'").get();
  let v=row?Number(row.value):0;
  if(v>SCHEMA_VERSION)throw Error(`coordinator database schema ${v} is newer than this build (${SCHEMA_VERSION})`);
  if(v<SCHEMA_VERSION){
    // Non-destructive: back up the old file before migrating (rollback = restore the copy).
    if(v>0&&fs.existsSync(file)){db.exec('pragma wal_checkpoint(truncate)');fs.copyFileSync(file,file+'.bak-v'+v);}
    for(;v<SCHEMA_VERSION;v++){
      db.exec('begin');
      try{db.exec(MIGRATIONS[v].replace(/^create table meta[^;]+;/,''));db.prepare("insert or replace into meta(key,value) values('schema_version',?)").run(String(v+1));db.exec('commit');}
      catch(e){db.exec('rollback');throw e;}
    }
  }
  return db;
}
export function tx(db,fn){
  db.exec('begin immediate');
  try{const r=fn();db.exec('commit');return r;}catch(e){try{db.exec('rollback');}catch{}throw e;}
}
