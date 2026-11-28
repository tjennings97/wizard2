import { operationOf, tableOf } from './db';

describe('query classification for the database metrics', () => {
  it('maps Knex methods to the four operations', () => {
    expect(operationOf({ method: 'first', sql: 'select * from "users" limit ?' })).toBe('select');
    expect(operationOf({ method: 'pluck', sql: 'select "id" from "games"' })).toBe('select');
    expect(operationOf({ method: 'insert', sql: 'insert into "game_events" ...' })).toBe('insert');
    expect(operationOf({ method: 'counter', sql: 'update "rooms" set ...' })).toBe('update');
    expect(operationOf({ method: 'del', sql: 'delete from "sessions" where ...' })).toBe('delete');
  });

  it('reads raw statements by their keyword and skips everything else', () => {
    expect(operationOf({ method: 'raw', sql: 'select 1' })).toBe('select');
    expect(operationOf({ method: 'raw', sql: '  UPDATE rooms SET state = ?' })).toBe('update');
    expect(operationOf({ sql: 'BEGIN;' })).toBeNull();
    expect(operationOf({ method: 'raw', sql: 'COMMIT;' })).toBeNull();
    expect(operationOf({ method: 'raw', sql: 'create table x (id int)' })).toBeNull();
  });

  it('labels the first schema table the statement names, else other', () => {
    expect(tableOf('select * from "room_members" as "rm" where ...')).toBe('room_members');
    expect(tableOf('insert into "bug_reports" ("id") values (?)')).toBe('bug_reports');
    expect(tableOf('update "games" set "state" = ?')).toBe('games');
    expect(tableOf('delete from "sessions" where "user_id" = ?')).toBe('sessions');
    expect(tableOf('select * from "knex_migrations"')).toBe('other');
    expect(tableOf('select 1')).toBe('other');
    expect(tableOf(undefined)).toBe('other');
  });
});
