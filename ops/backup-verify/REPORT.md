# Backup restore verification — preparation report (generated 2026-10-12T18:24:00Z)

Production was NOT contacted. See sections below. Hashes are full SHA-256.

## SHA-256 of every final script
```
1ee41cdc88250fb0f1fdba6db2a9313e225bfe99176fa0e952fa5def069fc436  run.sh
71eba5c3d6e2fcdc4f4c5a3c4d5950c900c1fe8cedeffb52423170b82da0aadc  snapshot_dump.sql
da58c83a44780fe639e0f0f574a8b10ae25637d15fdabd17dd19b43475795b14  bundle_postcheck.sh
8f96222c0b4e08e13ea609f06b17732b648ba1bc378cf004426ed6b17a5d9430  host_run.sh
a21097601806f2d289888b5ed1ace2514d6757adda4c67d3cafaf84bee8fd123  restore-manifest.sh
2df800ebf62ef4cb1b5616e7205cc1f67658af9ae48ea22446b9393e4feb910f  manifest_check.sh
01d248927f3ddcab5d806f06a5db7cdf3484ce43a6aff5775443d74684b26348  local_restore_env.sh
faa3b06d4f39e6f3ceaebc56d57668463ea85a31e427099e8c9834cf176b8980  tests/env.sh
16c92102434e012efd89500df82fdafd04d89b07942965d078f350885577562f  tests/lib.sh
ff15a919e038804a3d971308b7543a1c8b6ed0590ccc6cb77d5ec83523eb53ea  tests/t1_production_side.sh
3ee23d994f44801eaa55ad4d2775a0560062a70e27ce0855facc8eaee26a92f6  tests/t2_bundle_and_manifest.sh
371602e61deff7acb2b87a65176f3edf18cc752f3ae91e347a837e787fd79040  tests/t3_restore.sh
b9f9f284cd4b6854e3158897386a3204beb4cfce498e26e990cc32cf90a5d339  tests/t4_postcheck_linux.sh
29561f04576808326a92b45a97d942af30f825010995df7bce85f291a7f59248  tests/t5_host_run.sh
3eb77384ba87a00f4f884617a5c80d0f25a055eb704894179f571aa747d36664  server/scripts/restore.sh (UNCHANGED, git shows no modification)
```

## Test results (verbatim)
### t1
```
################ environment
server: PostgreSQL 16.15 on x86_64-pc-linux-musl, compiled by gcc (A | client image: postgres:16-alpine | db: trivo_prod | sessions now: 0
NOTICE:  relation "snap_probe" already exists, skipping
################ A. SUCCESS
        SNAPSHOT_OK: OK
        BUNDLE_OK /out/bundle-20261012T173531Z-b73d0787 tables=141
PASS  A1 success: rc=0, one bundle dir with exactly 4 files, no .tmp-* | expected: rc=0; bundle + 4 files | actual: rc=0; [bundle-20261012T173531Z-b73d0787 bundle-20261012T173531Z-b73d0787/SHA256SUMS bundle-20261012T173531Z-b73d0787/SNAPSHOT_OK bundle-20261012T173531Z-b73d0787/manifest.tsv bundle-20261012T173531Z-b73d0787/trivo_snap.dump ]
PASS  A2 permissions: bundle dir 700, every file 600, owner root | expected: 700 + 4x600 root | actual: 700 root bundle-20261012T173531Z-b73d0787;600 root bundle-20261012T173531Z-b73d0787/SHA256SUMS;600 root bundle-20261012T173531Z-b73d0787/SNAPSHOT_OK;600 root bundle-20261012T173531Z-b73d0787/manifest.tsv;600 root bundle-20261012T173531Z-b73d0787/trivo_snap.dump;
PASS  A3 log says BUNDLE_OK and client tools are 16.x | expected: BUNDLE_OK + 16.x | actual: BUNDLE_OK /out/bundle-20261012T173531Z-b73d0787 tables=141; client tools: psql (PostgreSQL) 16.15 | pg_dump (PostgreSQL) 16.15
PASS  A4 no customer value (a real client name) appears in the log | expected: absent | actual: searched for a 19-char client name
PASS  A5 manifest has no customer value | expected: absent | actual: grep for the client name
PASS  A6 transferred-bundle check on the host (restore-manifest.sh --verify-only, no database) | expected: rc=0 BUNDLE VERIFIED | actual: rc=0; BUNDLE VERIFIED (verify-only): no database was contacted.
PASS  A7 manifest table count equals the live table count | expected: 141 | actual: 141 vs live 141
################ B. ORDINARY FAILURES (each must publish nothing and leave nothing)
        REFUSING: connected database is not the expected one
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B1 wrong database name | expected: rc!=0; nothing left; log has 'REFUSING: connected database' | actual: rc=1; left=[]
        REFUSING: connected role is not the expected one
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B2 wrong role name | expected: rc!=0; nothing left; log has 'REFUSING: connected role' | actual: rc=1; left=[]
        REFUSING: psql is major version 18, expected 16 (client and server must match)
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B3 client tools of the wrong major version (18 vs 16) | expected: rc!=0; nothing left; log has 'REFUSING: psql is major version 18' | actual: rc=1; left=[]
        FAILED: cannot connect
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B4 wrong password | expected: rc!=0; nothing left; log has 'FAILED: cannot connect' | actual: rc=1; left=[]
        FAILED: cannot connect
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B5 server unreachable (closed port) | expected: rc!=0; nothing left; log has 'FAILED: cannot connect' | actual: rc=1; left=[]
        FAILED: dump is not readable
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B6 dump unreadable (truncated) | expected: rc!=0; nothing left; log has 'FAILED: dump is not readable' | actual: rc=1; left=[]
        FAILED: manifest has 140 rows, table_count=141, end=141
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B7 manifest row dropped (count/end disagree) | expected: rc!=0; nothing left; log has 'FAILED: manifest has' | actual: rc=1; left=[]
        FAILED: manifest has 142 rows, table_count=141, end=141
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B8 manifest row duplicated | expected: rc!=0; nothing left; log has 'FAILED: manifest has' | actual: rc=1; left=[]
        FAILED: manifest header
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B9 manifest header corrupted | expected: rc!=0; nothing left; log has 'FAILED: manifest header' | actual: rc=1; left=[]
        FAILED: dump table list differs from manifest table list
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B10 manifest table list differs from the dump's | expected: rc!=0; nothing left; log has 'FAILED: dump table list differs' | actual: rc=1; left=[]
        TEST-INJECTED FAILURE at checksum
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B11 checksum generation fails | expected: rc!=0; nothing left; log has 'TEST-INJECTED FAILURE at checksum' | actual: rc=1; left=[]
        SNAPSHOT_OK: OK
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B12 checksum verification fails (dump altered after sums written) | expected: rc!=0; nothing left; log has 'FAILED' | actual: rc=1; left=[]
        TEST-INJECTED FAILURE at rename
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B13 rename (publication) fails after checksums verified | expected: rc!=0; nothing left; log has 'TEST-INJECTED FAILURE at rename' | actual: rc=1; left=[]
PASS  B14 not enough free disk (20 MB tmpfs) is refused before anything is written | expected: rc!=0; REFUSING: only ... KB free | actual: rc=1; REFUSING: only 20480 KB free in /out, need at least 366894 KB (2x database size + 100 MB)
        FAILED: pg_dump did not exit 0 (rc=1)
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B15 pg_dump fails after the guards and the manifest counts passed (sequence privilege revoked mid-run) | expected: rc!=0; FAILED: pg_dump did not exit 0; nothing left | actual: rc=1; left=[]; FAILED: pg_dump did not exit 0 (rc=1)
        REFUSING: /out/taken already exists (will not overwrite)
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B16 destination name already exists: refused, existing directory untouched and not nested into | expected: rc!=0; [bundle-OLD, bundle-OLD/trivo_snap.dump, taken, taken/marker.txt] only | actual: rc=1; [bundle-OLD bundle-OLD/trivo_snap.dump taken taken/marker.txt ]
        /out/.tmp-OLDRUN
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B17 stale .tmp-* from an earlier run: new run refuses, evidence untouched | expected: rc!=0; only [.tmp-OLDRUN, .tmp-OLDRUN/trivo_snap.dump]; content EVIDENCE | actual: rc=1; [.tmp-OLDRUN .tmp-OLDRUN/trivo_snap.dump ]
PASS  B18 two successful runs in one directory: two distinct bundles, neither touched | expected: rc=0; 2 bundles x 5 entries | actual: rc=0; 2 bundles
        REFUSING: 1 other session(s) of role trivo_backup are active (a backup running? an earlier killed run still closing?)
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  B19 another session of the backup role is active (e.g. the nightly dump): refused before the snapshot, nothing left | expected: rc!=0; REFUSING: 1 other session(s) | actual: rc=1; REFUSING: 1 other session; left=[]
################ C. FORCED TERMINATION at each stage (SIGKILL: no trap runs; SIGTERM/docker stop: trap runs)
        C1k: signal=KILL stopped in 1s, exit=137, remains: [.tmp-20261012T173855Z-0586524e ]
PASS  C1 SIGKILL after mkdir: only an empty stale .tmp-* remains, nothing published | expected: [.tmp-X] | actual: [.tmp-20261012T173855Z-0586524e ]
        /out/.tmp-20261012T173855Z-0586524e
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  C1b follow-up run refuses (stale dir) and changes nothing | expected: rc!=0, same listing | actual: rc=1; [.tmp-20261012T173855Z-0586524e ]
        C1t: signal=TERM stopped in 2s, exit=143, remains: []
PASS  C1t SIGTERM after mkdir: exit 143, this run's own staging dir removed, nothing remains | expected: exit 143; [] | actual: exit=143 [] took 2s
        C1s: signal=STOP stopped in 2s, exit=130, remains: []
PASS  C1s docker stop (SIGINT, the postgres image's STOPSIGNAL) after mkdir: exit 130, own staging dir removed | expected: exit 130; [] | actual: exit=130 []
        snapshot-holding session while paused: 1
PASS  C2t SIGTERM inside the snapshot transaction: exit 143, container gone, own staging dir removed; the only DB session left is the test hook's pg_sleep backend (terminated by the test) | expected: exit 143; nothing left; sessions after cleanup=0 | actual: exit=143; lingering pg_sleep backends=1; left=[]; sessions now=0
        Ck_after_dump: signal=KILL stopped in 0s, exit=137, remains: [.tmp-20261012T173916Z-eb9238e6 .tmp-20261012T173916Z-eb9238e6/manifest.tsv .tmp-20261012T173916Z-eb9238e6/trivo_snap.dump ]
PASS  C after_dump SIGKILL: stale .tmp-* with unpublished files only; no bundle-* | expected: [.tmp-X, .tmp-X/files...]; no bundle | actual: [.tmp-20261012T173916Z-eb9238e6 .tmp-20261012T173916Z-eb9238e6/manifest.tsv .tmp-20261012T173916Z-eb9238e6/trivo_snap.dump ]
        /out/.tmp-20261012T173916Z-eb9238e6
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  C after_dump follow-up run refused; nothing deleted or changed | expected: rc!=0; same listing | actual: rc=1
        Ct_after_dump: signal=TERM stopped in 1s, exit=143, remains: []
PASS  C after_dump SIGTERM: exit 143, own staging dir removed; nothing published | expected: exit 143; [] | actual: exit=143 []
        Ck_validated: signal=KILL stopped in 1s, exit=137, remains: [.tmp-20261012T173943Z-1ec3a1e1 .tmp-20261012T173943Z-1ec3a1e1/manifest.tsv .tmp-20261012T173943Z-1ec3a1e1/trivo_snap.dump ]
PASS  C validated SIGKILL: stale .tmp-* with unpublished files only; no bundle-* | expected: [.tmp-X, .tmp-X/files...]; no bundle | actual: [.tmp-20261012T173943Z-1ec3a1e1 .tmp-20261012T173943Z-1ec3a1e1/manifest.tsv .tmp-20261012T173943Z-1ec3a1e1/trivo_snap.dump ]
        /out/.tmp-20261012T173943Z-1ec3a1e1
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  C validated follow-up run refused; nothing deleted or changed | expected: rc!=0; same listing | actual: rc=1
        Ct_validated: signal=TERM stopped in 1s, exit=143, remains: []
PASS  C validated SIGTERM: exit 143, own staging dir removed; nothing published | expected: exit 143; [] | actual: exit=143 []
        Ck_checksummed: signal=KILL stopped in 0s, exit=137, remains: [.tmp-20261012T174009Z-a26375e0 .tmp-20261012T174009Z-a26375e0/SHA256SUMS .tmp-20261012T174009Z-a26375e0/SNAPSHOT_OK .tmp-20261012T174009Z-a26375e0/manifest.tsv .tmp-20261012T174009Z-a26375e0/trivo_snap.dump ]
PASS  C checksummed SIGKILL: stale .tmp-* with unpublished files only; no bundle-* | expected: [.tmp-X, .tmp-X/files...]; no bundle | actual: [.tmp-20261012T174009Z-a26375e0 .tmp-20261012T174009Z-a26375e0/SHA256SUMS .tmp-20261012T174009Z-a26375e0/SNAPSHOT_OK .tmp-20261012T174009Z-a26375e0/manifest.tsv .tmp-20261012T174009Z-a26375e0/trivo_snap.dump ]
        /out/.tmp-20261012T174009Z-a26375e0
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  C checksummed follow-up run refused; nothing deleted or changed | expected: rc!=0; same listing | actual: rc=1
        Ct_checksummed: signal=TERM stopped in 1s, exit=143, remains: []
PASS  C checksummed SIGTERM: exit 143, own staging dir removed; nothing published | expected: exit 143; [] | actual: exit=143 []
        Ck_renamed: signal=KILL stopped in 0s, exit=137, remains: [bundle-20261012T174037Z-038a1a85 bundle-20261012T174037Z-038a1a85/SHA256SUMS bundle-20261012T174037Z-038a1a85/SNAPSHOT_OK bundle-20261012T174037Z-038a1a85/manifest.tsv bundle-20261012T174037Z-038a1a85/trivo_snap.dump ]
PASS  C renamed SIGKILL: published bundle is complete and verifies; no .tmp-* | expected: bundle checksums OK; no .tmp | actual: rc=0 [bundle-20261012T174037Z-038a1a85 bundle-20261012T174037Z-038a1a85/SHA256SUMS bundle-20261012T174037Z-038a1a85/SNAPSHOT_OK bundle-20261012T174037Z-038a1a85/manifest.tsv bundle-20261012T174037Z-038a1a85/trivo_snap.dump ]
PASS  C renamed follow-up: a SECOND bundle is created, the first untouched | expected: rc=0; 2 bundles | actual: rc=0; 2 bundles
        Ct_renamed: signal=TERM stopped in 2s, exit=143, remains: [bundle-20261012T174059Z-cd226705 bundle-20261012T174059Z-cd226705/SHA256SUMS bundle-20261012T174059Z-cd226705/SNAPSHOT_OK bundle-20261012T174059Z-cd226705/manifest.tsv bundle-20261012T174059Z-cd226705/trivo_snap.dump ]
PASS  C renamed SIGTERM: published bundle remains complete | expected: bundle present, no .tmp | actual: [bundle-20261012T174059Z-cd226705 bundle-20261012T174059Z-cd226705/SHA256SUMS bundle-20261012T174059Z-cd226705/SNAPSHOT_OK bundle-20261012T174059Z-cd226705/manifest.tsv bundle-20261012T174059Z-cd226705/trivo_snap.dump ]
PASS  C SIGKILL while pg_dump is writing: a stale .tmp-* appears, NO new bundle (only the earlier one), DB sessions released | expected: stale .tmp-*; bundles={earlier}; sessions=0 | actual: [.tmp-20261012T174122Z-db0b7786 .tmp-20261012T174122Z-db0b7786/manifest.tsv .tmp-20261012T174122Z-db0b7786/trivo_snap.dump bundle-20261012T174112Z-2c8559db bundle-20261012T174112Z-2c8559db/SHA256SUMS bundle-20261012T174112Z-2c855
        /out/.tmp-20261012T174122Z-db0b7786
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  C pg_dump-kill follow-up refused, nothing changed | expected: rc!=0, same listing | actual: rc=1
PASS  C recovery: after the operator removes the stale .tmp-* by hand, a new run succeeds; the earlier completed bundle is untouched and still verifies | expected: rc=0; 2 bundles; no .tmp-*; first bundle verifies | actual: rc=0; 2 bundles; first bundle verify rc=0
        REFUSING: another run holds /out/.run.lock
        FAILED (exit 1): this run's staging directory was removed; nothing was published
PASS  C2 a second run while one is in progress is refused (lock), the first is unaffected | expected: rc!=0; REFUSING: another run holds | actual: rc=1; REFUSING: another run holds 
################ D. GUARDS (fail closed, name of the failing guard asserted)
        CONTEXT:  PL/pgSQL function inline_code_block line 11 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D1 role WITHOUT BYPASSRLS (trivo_runtime) | expected: rc!=0; GUARD_FAILED:role_bypasses_rls; nothing left | actual: rc=3; GUARD_FAILED:role_bypasses_rls; left=[]
        CONTEXT:  PL/pgSQL function inline_code_block line 10 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D2 superuser role (postgres) | expected: rc!=0; GUARD_FAILED:role_is_not_superuser; nothing left | actual: rc=3; GUARD_FAILED:role_is_not_superuser; left=[]
        CONTEXT:  PL/pgSQL function inline_code_block line 32 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D2b trivo_platform (BYPASSRLS, can write, cannot read _prisma_migrations) | expected: rc!=0; GUARD_FAILED:can_select_every_table; nothing left | actual: rc=3; GUARD_FAILED:can_select_every_table; left=[]
NOTICE:  table "snap_nosel" does not exist, skipping
        CONTEXT:  PL/pgSQL function inline_code_block line 32 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D3 an ordinary public table the role cannot SELECT | expected: rc!=0; GUARD_FAILED:can_select_every_table; nothing left | actual: rc=3; GUARD_FAILED:can_select_every_table; left=[]
NOTICE:  table "snap_noseq" does not exist, skipping
        CONTEXT:  PL/pgSQL function inline_code_block line 35 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D4 a public sequence the role cannot SELECT | expected: rc!=0; GUARD_FAILED:can_select_every_sequence; nothing left | actual: rc=3; GUARD_FAILED:can_select_every_sequence; left=[]
        CONTEXT:  PL/pgSQL function inline_code_block line 41 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D5 role holding an INSERT privilege | expected: rc!=0; GUARD_FAILED:role_has_no_write_privileges; nothing left | actual: rc=3; GUARD_FAILED:role_has_no_write_privileges; left=[]
NOTICE:  schema "snap_other" does not exist, skipping
        CONTEXT:  PL/pgSQL function inline_code_block line 26 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D6 an ordinary table outside schema public (manifest could not describe it) | expected: rc!=0; GUARD_FAILED:no_tables_outside_public; nothing left | actual: rc=3; GUARD_FAILED:no_tables_outside_public; left=[]
NOTICE:  drop cascades to table snap_other.t
NOTICE:  table "snap_part" does not exist, skipping
        CONTEXT:  PL/pgSQL function inline_code_block line 29 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D7 a partitioned table in public | expected: rc!=0; GUARD_FAILED:no_partitioned_tables; nothing left | actual: rc=3; GUARD_FAILED:no_partitioned_tables; left=[]
        CONTEXT:  PL/pgSQL function inline_code_block line 13 at RAISE
        FAILED (exit 3): this run's staging directory was removed; nothing was published
PASS  D8 PG16 client against a PG18 server is refused by the server-major guard | expected: rc!=0; GUARD_FAILED:server_major_version_is_expected; nothing left | actual: rc=3; GUARD_FAILED:server_major_version_is_expected; left=[]
        SNAPSHOT_OK: OK
        BUNDLE_OK /out/bundle-20261012T174235Z-dca1f998 tables=141
PASS  D9 after the fixtures are removed the SAME run succeeds (guards are not blanket failures) | expected: rc=0 | actual: rc=0
        non-SELECT privileges held by trivo_backup in schema public (must be none): [0]
        write attempt as trivo_backup: ERROR:  permission denied for schema public
################ E. CONCURRENT WRITES DURING THE SNAPSHOT WINDOW
NOTICE:  table "snap_ddl_during" does not exist, skipping
        writer finished at +4s (inside the 12s hold, AFTER the snapshot was exported)
        SNAPSHOT_OK: OK
        BUNDLE_OK /out/bundle-20261012T174245Z-6b652d37 tables=141
PASS  E1 run succeeded with a concurrent writer | expected: rc=0 | actual: rc=0
PASS  E2 manifest counts the table as of the snapshot (3), not the live table (7) | expected: snap_probe=3, live>3 | actual: manifest=3 live=7
PASS  E3 the dump holds exactly the three original rows: no DURING row, no update, the deleted row still present | expected: before-1,before-2,before-3, | actual: before-1,before-2,before-3,
PASS  E4 a table created during the window is in neither the manifest nor the dump | expected: absent | actual: manifest: 0, dump: 0
        E bundle kept for the restore tests: /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t1173530/E_bundle/bundle-20261012T174245Z-6b652d37
RESULT pass=61 fail=0
logs: /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t1173530
```
### t3
```
################ H. REFUSALS (no database may be created or touched)
PASS  H1 | expected: rc!=0; 'RESTORE_EXPECT_SYSTEM_IDENTIFIER'; database count unchanged (15) | actual: rc=1; ; dbs=15
PASS  H2 | expected: rc!=0; 'not the local machine'; database count unchanged (15) | actual: rc=1; REFUSING: ADMIN_DATABASE_URL points at host 'db.example.com', not the local machine; dbs=15
PASS  H3 | expected: rc!=0; 'uses port 5432, expected 54329'; database count unchanged (15) | actual: rc=1; REFUSING: OWNER_DATABASE_URL uses port 5432, expected 54329; dbs=15
PASS  H4 | expected: rc!=0; 'overrides host/port/service'; database count unchanged (15) | actual: rc=1; REFUSING: SOURCE_DATABASE_URL overrides host/port/service in its query string; dbs=15
PASS  H5 | expected: rc!=0; 'not the local machine'; database count unchanged (15) | actual: rc=1; REFUSING: RUNTIME_DATABASE_URL_TEMPLATE points at host '10.0.0.5', not the local machine; dbs=15
PASS  H6 | expected: rc!=0; 'different system_identifier'; database count unchanged (15) | actual: rc=1; REFUSING: the instance behind ADMIN_DATABASE_URL has a different system_identifier than expected - not the intended local instance; dbs=15
PASS  H7 | expected: rc!=0; 'must match trivo_*(verify|restore|scratch|test)*'; database count unchanged (15) | actual: rc=1; REFUSING: scratch database name 'trivo_prod' must match trivo_*(verify|restore|scratch|test)* (never a live database name); dbs=15
PASS  H8 | expected: rc!=0; 'must match'; database count unchanged (15) | actual: rc=1; REFUSING: scratch database name 'postgres' must match trivo_*(verify|restore|scratch|test)* (never a live database name); dbs=15
PASS  H9 | expected: rc!=0; 'must match'; database count unchanged (15) | actual: rc=1; REFUSING: scratch database name 'trivo_prodverify_x; drop database postgres' must match trivo_*(verify|restore|scratch|test)* (never a live ; dbs=15
PASS  H10 | expected: rc!=0; 'already exists'; database count unchanged (15) | actual: rc=1; REFUSING: database trivo_prodverify_smoke18_b already exists (this script never overwrites or drops a database); dbs=15
PASS  H11 | expected: rc!=0; 'different system_identifier'; database count unchanged (15) | actual: rc=1; REFUSING: the instance behind ADMIN_DATABASE_URL has a different system_identifier than expected - not the intended local instance; dbs=15
PASS  H12 | expected: rc!=0; 'Usage'; database count unchanged (15) | actual: rc=1; ; dbs=15
PASS  H13 an existing database is untouched by a refused restore attempt | expected: same oid and size | actual: oid 106705->106705 size 136468159->136468159
PASS  H14 the restore scripts contain no executed DROP DATABASE / TRUNCATE / DELETE statement | expected: 0 (only the operator hint text) | actual: 0 matches
################ R. FULL RESTORE of the good bundle into a NEW scratch database
          ok:   owner, verification and runtime connections all reach the scratch database created on the intended instance
        == restoring /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t1173530/E_bundle/bundle-20261012T174245Z-6b652d37/trivo_snap.dump with pg_restore (PostgreSQL) 18.1
        == re-applying db-secure.sql (grants + FORCE RLS), sha256 8389754c6577f64d…
        == verification
          ok:   row counts identical to the snapshot manifest in all 141 tables (table sets identical)
          ok:   tenant_isolation policies: 134 (identical to the source snapshot)
          ok:   tables with RLS enabled AND forced: 134 (identical to the source snapshot)
          ok:   composite (id, companyId) foreign keys: 166 (identical to the source snapshot)
          ok:   every policy-protected table has RLS enabled AND forced
          ok:   every journal entry balances
          ok:   no plain foreign key anywhere points at another company's row (51 company-scoped foreign keys scanned)
          ok:   runtime role: no rows with no context or an unknown company, and exactly each company's own rows in each of 6 company context(s), on all 134 company-scoped RLS tables (100 empty, so tested only for 'sees nothing')
        
        RESTORE VERIFIED into trivo_prodverify_r1_final3 (kept; nothing was dropped). When finished, YOU may drop it:  psql "$ADMIN_DATABASE_URL" -c 'DROP DATABASE "trivo_prodverify_r1_final3"'
PASS  R1 restore + all verifications pass | expected: rc=0; RESTORE VERIFIED; scratch database exists (kept) | actual: rc=0; exists=yes
PASS  R1b every verification line is an ok line (no FAIL) | expected: 0 FAIL lines | actual: 0 FAIL lines, 12 ok lines
PASS  R1c restored snap_probe equals the SNAPSHOT (3 rows) not the live table | expected: 3 | actual: 3
################ S. A restore whose verification MUST FAIL: forged-consistent manifest + a tampered restored database
PASS  S0 the forged-consistent bundle passes the file-level checks (as designed: only the database comparison can catch it) | expected: rc=0 | actual: rc=0
          ok:   bundle complete: exactly 4 files, checksums match, manifest valid, marker bound to the manifest (snapshot 00000003-00000C59-1), dump readable and its table list/database/version equal the manife
          ok:   source: database trivo_prod, PostgreSQL 16.15, 141 tables, snapshot taken 2026-10-12T17:42:45Z
          ok:   admin connection is the intended local instance (port 54329, system_identifier matches), server 18.1
          ok:   owner, verification and runtime connections all reach the scratch database created on the intended instance
        psql:<stdin>:95: NOTICE:  TAMPER cross-company ref set on journal_lines.accountId
          FAIL: row count differs in accounts: manifest=271 restored=270
          FAIL: row count differs in snap_probe: manifest=3 restored=2
          FAIL: tenant_isolation policies: restored=133 but the source snapshot had 134
          FAIL: tables with RLS enabled AND forced: restored=133 but the source snapshot had 134
          ok:   composite (id, companyId) foreign keys: 166 (identical to the source snapshot)
          ok:   every policy-protected table has RLS enabled AND forced
          FAIL: 1 unbalanced journal entries
          FAIL: cross-company references: 1 violating rows (NOTICE:  VIOLATION journal_lines -> accounts (journal_lines_accountId_fkey): 1 rows;)
          FAIL: runtime role with NO company context saw rows in clients
          FAIL: runtime role in an UNKNOWN company context saw rows in clients
          FAIL: company cmugbu2y… in clients: runtime role saw '10006' rows, 5003 of them its own, expected 5003/5003
          FAIL: company cmugbuyj… in clients: runtime role saw '10006' rows, 5002 of them its own, expected 5002/5002
          FAIL: company cmugbzw1… in clients: runtime role saw '10006' rows, 0 of them its own, expected 0/0
          FAIL: company cmugc2vi… in clients: runtime role saw '10006' rows, 0 of them its own, expected 0/0
          FAIL: company cmugc3jk… in clients: runtime role saw '10006' rows, 1 of them its own, expected 1/1
          FAIL: company cmugc3p4… in clients: runtime role saw '10006' rows, 0 of them its own, expected 0/0
        RESTORE VERIFICATION FAILED (scratch DB trivo_prodverify_s1_final3 kept for inspection)
        FAILED (exit 1): scratch database trivo_prodverify_s1_final3 was KEPT for investigation (this script never drops databases)
PASS  S1 verification FAILS (rc=1) and the scratch database is KEPT | expected: rc=1; 'scratch DB ... kept'; database exists | actual: rc=1; exists=yes
PASS  S2 forged manifest count is caught against the restored data | expected: FAIL line containing 'row count differs in accounts' | actual: 1 match(es)
PASS  S3 the dropped tenant policy is caught (policy count) | expected: FAIL line containing 'tenant_isolation policies: restored=133 but the source snapshot had 134' | actual: 1 match(es)
PASS  S4 the lost RLS-forced table is caught | expected: FAIL line containing 'tables with RLS enabled AND forced: restored=' | actual: 1 match(es)
PASS  S5 the unbalanced journal is caught | expected: FAIL line containing 'unbalanced journal entries' | actual: 1 match(es)
PASS  S6 the cross-company reference is caught | expected: FAIL line containing 'cross-company references' | actual: 1 match(es)
PASS  S7 tenant escape is caught through the REAL runtime role (clients visible with no company context) | expected: FAIL line containing 'runtime role with NO company context saw rows in clients' | actual: 1 match(es)
PASS  S8 a deleted row is caught by the count comparison | expected: FAIL line containing 'row count differs in snap_probe' | actual: 1 match(es)
RESULT pass=26 fail=0
work dir: /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t3_final3
```
### t2
```
################ F. BUNDLE VERIFICATION (--verify-only) of the GOOD bundle and of forged/damaged copies
PASS  F0 good bundle verifies | expected: rc=0; BUNDLE VERIFIED | actual: rc=0; BUNDLE VERIFIED (verify-only): no database was contacted.
PASS  F1 extra file in the bundle | expected: rc!=0; 'unexpected contents'; no database contacted | actual: rc=1;   bundle: unexpected contents: [SHA256SUMS SNAPSHOT_OK evil.sh manifest.tsv trivo_snap.dump ] (expected exactly: SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump)|REFU
PASS  F2 success marker missing | expected: rc!=0; 'unexpected contents'; no database contacted | actual: rc=1;   bundle: unexpected contents: [SHA256SUMS manifest.tsv trivo_snap.dump ] (expected exactly: SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump)|REFUSING: bundle verific
PASS  F3 SHA256SUMS missing | expected: rc!=0; 'unexpected contents'; no database contacted | actual: rc=1;   bundle: unexpected contents: [SNAPSHOT_OK manifest.tsv trivo_snap.dump ] (expected exactly: SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump)|REFUSING: bundle verifi
PASS  F4 dump altered after checksumming | expected: rc!=0; 'checksum verification FAILED'; no database contacted | actual: rc=1; trivo_snap.dump: FAILED|sha256sum: WARNING: 1 computed checksum did NOT match|
PASS  F5 manifest edited after checksumming | expected: rc!=0; 'checksum verification FAILED'; no database contacted | actual: rc=1; manifest.tsv: FAILED|sha256sum: WARNING: 1 computed checksum did NOT match|
PASS  F6 manifest edited AND checksums regenerated (marker still binds the original) | expected: rc!=0; 'marker manifest_sha256 differs'; no database contacted | actual: rc=1;   bundle: marker manifest_sha256 differs from manifest.tsv|REFUSING: bundle verification failed - no database was created|
PASS  F7 marker names another snapshot id (checksums regenerated) | expected: rc!=0; 'marker snapshot_id differs'; no database contacted | actual: rc=1;   bundle: marker snapshot_id differs from the manifest (not the same snapshot)|REFUSING: bundle verification failed - no database was created|
PASS  F8 SHA256SUMS does not cover the manifest | expected: rc!=0; 'SHA256SUMS'; no database contacted | actual: rc=1;   bundle: SHA256SUMS lists [SNAPSHOT_OK trivo_snap.dump ], expected exactly SNAPSHOT_OK manifest.tsv trivo_snap.dump|  bundle: SHA256SUMS does not have exactly 3 lines|
PASS  F9 SHA256SUMS has an extra line | expected: rc!=0; 'SHA256SUMS'; no database contacted | actual: rc=1;   bundle: SHA256SUMS lists [SNAPSHOT_OK extra.txt manifest.tsv trivo_snap.dump ], expected exactly SNAPSHOT_OK manifest.tsv trivo_snap.dump|  bundle: SHA256SUMS does not 
PASS  F10 SHA256SUMS has a malformed hash | expected: rc!=0; 'SHA256SUMS'; no database contacted | actual: rc=1;   bundle: SHA256SUMS has a malformed line|REFUSING: bundle verification failed - no database was created|
PASS  F11 dump from ANOTHER snapshot swapped in (checksums regenerated) | expected: rc!=0; 'marker dump_sha256 differs'; no database contacted | actual: rc=1;   bundle: marker dump_sha256 differs from trivo_snap.dump|REFUSING: bundle verification failed - no database was created|
PASS  F12 manifest from ANOTHER snapshot swapped in (checksums regenerated) | expected: rc!=0; 'marker'; no database contacted | actual: rc=1;   bundle: marker snapshot_id differs from the manifest (not the same snapshot)|  bundle: marker manifest_sha256 differs from manifest.tsv|
PASS  F13 truncated dump, everything else made consistent | expected: rc!=0; 'dump is not readable'; no database contacted | actual: rc=1;   bundle: dump is not readable by pg_restore|REFUSING: bundle verification failed - no database was created|
PASS  F14 CRLF manifest, everything else made consistent | expected: rc!=0; 'contains CR'; no database contacted | actual: rc=1;   manifest: contains CR characters (must be LF-only; was it edited or transferred in text mode?)|REFUSING: bundle verification failed - no database was created|
PASS  F15 manifest names a table the dump does not hold (fully consistent forgery) | expected: rc!=0; 'table(s) in the dump but not in the manifest'; no database contacted | actual: rc=1;   bundle: table(s) in the dump but not in the manifest: accounts |  bundle: table(s) in the manifest but not in the dump: accountz |
PASS  F16 manifest replaced by a symlink/other file | expected: rc!=0; 'bundle:'; no database contacted | actual: rc=1; manifest.tsv: FAILED|sha256sum: WARNING: 1 computed checksum did NOT match|
PASS  F17 success marker truncated (no #end ok) | expected: rc!=0; 'marker:'; no database contacted | actual: rc=1;   marker: last line is not '#end<TAB>ok' (truncated?)|  marker: unexpected number of lines (expected 12)|
PASS  F18 marker points at a different dump file name | expected: rc!=0; 'dump_file'; no database contacted | actual: rc=1;   marker: dump_file is not trivo_snap.dump|REFUSING: bundle verification failed - no database was created|
PASS  F19 marker names a different database than the manifest | expected: rc!=0; 'marker database differs'; no database contacted | actual: rc=1;   bundle: marker database differs from the manifest (not the same snapshot)|REFUSING: bundle verification failed - no database was created|
PASS  F20 nonexistent directory | expected: rc!=0; 'not a directory'; no database contacted | actual: rc=1;   bundle: not a directory: /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t2_182008/does-not-exist|REFUSING: bundl
PASS  F21 empty directory | expected: rc!=0; 'unexpected contents'; no database contacted | actual: rc=1;   bundle: unexpected contents: [] (expected exactly: SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump)|REFUSING: bundle verification failed - no database was created|
PASS  F22 restore form with a damaged bundle refuses before any database exists | expected: rc!=0; REFUSING; database count unchanged; no such database | actual: rc=1; dbs 17 -> 17; exists=0
################ G. STRICT MANIFEST VALIDATION (validate_manifest) and COMPARISON with a restored database
PASS  G valid manifest vs the restored database | expected: pass | actual: rc=0:   ok:   row counts identical to the snapshot manifest in all 141 tables (table sets identical)|
PASS  G CRLF line endings | expected: fail | actual: rc=1:   manifest: contains CR characters (must be LF-only; was it edited or transferred in text mode?)|
PASS  G empty file | expected: fail | actual: rc=1:   manifest: missing or empty|
PASS  G missing format header | expected: fail | actual: rc=1:   manifest: first line is not '#trivo-count-manifest<TAB>v2'|
PASS  G wrong version (v1) | expected: fail | actual: rc=1:   manifest: first line is not '#trivo-count-manifest<TAB>v2'|
PASS  G truncated: no #end | expected: fail | actual: rc=1:   manifest: last line is not '#end' (truncated?)|  manifest: header '#end' appears 0 times (expected exactly 1)|
PASS  G truncated mid-file | expected: fail | actual: rc=1:   manifest: last line is not '#end' (truncated?)|  manifest: header '#end' appears 0 times (expected exactly 1)|
PASS  G missing #database header | expected: fail | actual: rc=1:   manifest: header '#database' appears 0 times (expected exactly 1)|  manifest: #database is not a plain identifier|
PASS  G missing #server_version header | expected: fail | actual: rc=1:   manifest: header '#server_version' appears 0 times (expected exactly 1)|  manifest: #server_version is malformed|
PASS  G missing #snapshot_id header | expected: fail | actual: rc=1:   manifest: header '#snapshot_id' appears 0 times (expected exactly 1)|  manifest: #snapshot_id is malformed|
PASS  G missing #pg_snapshot header | expected: fail | actual: rc=1:   manifest: header '#pg_snapshot' appears 0 times (expected exactly 1)|  manifest: #pg_snapshot is malformed|
PASS  G missing #txn_start_utc header | expected: fail | actual: rc=1:   manifest: header '#txn_start_utc' appears 0 times (expected exactly 1)|  manifest: #txn_start_utc is malformed|
PASS  G missing #relation_set header | expected: fail | actual: rc=1:   manifest: header '#relation_set' appears 0 times (expected exactly 1)|  manifest: #relation_set is not the expected definition|
PASS  G missing #table_count header | expected: fail | actual: rc=1:   manifest: header '#table_count' appears 0 times (expected exactly 1)|  manifest: #table_count= but 141 table rows present|
PASS  G missing #tenant_isolation_policies header | expected: fail | actual: rc=1:   manifest: header '#tenant_isolation_policies' appears 0 times (expected exactly 1)|  manifest: #tenant_isolation_policies is not a non-negative inte
PASS  G missing #forced_rls_tables header | expected: fail | actual: rc=1:   manifest: header '#forced_rls_tables' appears 0 times (expected exactly 1)|  manifest: #forced_rls_tables is not a non-negative integer|
PASS  G missing #composite_company_fks header | expected: fail | actual: rc=1:   manifest: header '#composite_company_fks' appears 0 times (expected exactly 1)|  manifest: #composite_company_fks is not a non-negative integer|
PASS  G duplicate #database header | expected: fail | actual: rc=1:   manifest: header '#database' appears 2 times (expected exactly 1)|
PASS  G unknown header line | expected: fail | actual: rc=1:   manifest: unknown header line(s): #surprise|
PASS  G different relation_set definition | expected: fail | actual: rc=1:   manifest: #relation_set is not the expected definition|
PASS  G malformed #snapshot_id | expected: fail | actual: rc=1:   manifest: #snapshot_id is malformed|
PASS  G malformed #txn_start_utc | expected: fail | actual: rc=1:   manifest: #txn_start_utc is malformed|
PASS  G non-numeric #tenant_isolation_policies | expected: fail | actual: rc=1:   manifest: #tenant_isolation_policies is not a non-negative integer|
PASS  G duplicate table row | expected: fail | actual: rc=1:   manifest: duplicate table(s): _prisma_migrations |  manifest: #table_count=141 but 142 table rows present|
PASS  G non-numeric count | expected: fail | actual: rc=1:   manifest: malformed data line 13 (need <table><TAB><non-negative integer>)|
PASS  G negative count | expected: fail | actual: rc=1:   manifest: malformed data line 13 (need <table><TAB><non-negative integer>)|
PASS  G extra column | expected: fail | actual: rc=1:   manifest: malformed data line 13 (need <table><TAB><non-negative integer>)|
PASS  G blank line | expected: fail | actual: rc=1:   manifest: malformed data line 153 (need <table><TAB><non-negative integer>)|  manifest: #table_count=141 but 142 table rows present|
PASS  G illegal table name | expected: fail | actual: rc=1:   manifest: malformed data line 13 (need <table><TAB><non-negative integer>)|
PASS  G #table_count mismatch | expected: fail | actual: rc=1:   manifest: #table_count=999 but 141 table rows present|
PASS  G count mismatch (+1 in accounts) | expected: fail | actual: rc=1:   FAIL: row count differs in accounts: manifest=271 restored=270|
PASS  G count mismatch (a live count instead of the snapshot count) | expected: fail | actual: rc=1:   FAIL: row count differs in snap_probe: manifest=999 restored=3|
PASS  G table missing from the manifest (restored has it) | expected: fail | actual: rc=1:   FAIL: table(s) in the restored database but NOT in the manifest: approval_history |
PASS  G extra table in the manifest (restored lacks it) | expected: fail | actual: rc=1:   FAIL: table(s) in the manifest but NOT in the restored database: ghost_table |  FAIL: row count differs in ghost_table: manifest=0 restored=ERR|
        databases before/after these tests: 17 / 17 (no database was created or dropped)
PASS  G-end no database was created by the no-database tests | expected: unchanged | actual: 17 -> 17
RESULT pass=58 fail=0
work dir: /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t2_182008
```
### t4
```
work dir (my own, root-only): /tmp/trivo_pc_OhfrJc   kernel: Linux 6.18.40.1-microsoft-standard-WSL2
PASS  P0 a correct bundle (700 dir, 600 files, root) passes | expected: rc=0; POSTCHECK OK | actual: rc=0; trivo_snap.dump: OK
manifest.tsv: OK
SNAPSHOT_OK: OK
POSTCHECK OK /tmp/trivo_pc_OhfrJc/p0 tables=141 server=16.15 snapshot=00000003-00000C59-1
PASS  P1 directory mode 755 | expected: rc!=0; 'mode 700' | actual: rc=1; POSTCHECK FAILED: bundle directory must be mode 700 owned by root (found 755 root)
PASS  P2 dump file mode 644 | expected: rc!=0; 'must be mode 600' | actual: rc=1; POSTCHECK FAILED: trivo_snap.dump must be mode 600 owned by root (found 644 root)
PASS  P3 SHA256SUMS mode 640 | expected: rc!=0; 'must be mode 600' | actual: rc=1; POSTCHECK FAILED: SHA256SUMS must be mode 600 owned by root (found 640 root)
PASS  P4 a file owned by another user | expected: rc!=0; 'owned by root' | actual: rc=1; POSTCHECK FAILED: manifest.tsv must be mode 600 owned by root (found 600 nobody)
PASS  P5 directory owned by another user | expected: rc!=0; 'owned by root' | actual: rc=1; POSTCHECK FAILED: bundle directory must be mode 700 owned by root (found 700 nobody)
PASS  P6 an extra file | expected: rc!=0; 'exactly the four' | actual: rc=1; POSTCHECK FAILED: bundle does not contain exactly the four expected files
PASS  P7 a missing file | expected: rc!=0; 'exactly the four' | actual: rc=1; POSTCHECK FAILED: bundle does not contain exactly the four expected files
PASS  P8 a symlink instead of the manifest | expected: rc!=0; 'not a regular file' | actual: rc=1; POSTCHECK FAILED: manifest.tsv is not a regular file
PASS  P9 dump altered after checksumming | expected: rc!=0; 'checksum verification failed' | actual: rc=1; trivo_snap.dump: FAILED
PASS  P10 success marker truncated | expected: rc!=0; 'success marker is missing or incomplete' | actual: rc=1; trivo_snap.dump: OK
PASS  P11 SHA256SUMS with a 4th line | expected: rc!=0; 'exactly 3 lines' | actual: rc=1; POSTCHECK FAILED: SHA256SUMS must have exactly 3 lines
PASS  P12 the wrong database expected | expected: rc!=0; 'marker names a different database' | actual: rc=1; trivo_snap.dump: OK
PASS  P13 manifest edited and checksums regenerated (marker still binds the original) | expected: rc!=0; 'marker manifest_sha256 differs' | actual: rc=1; trivo_snap.dump: OK
PASS  P14 not a bundle directory | expected: rc!=0; 'not a real directory' | actual: rc=1; POSTCHECK FAILED: /tmp/trivo_pc_OhfrJc/nonexistent is not a real directory
RESULT pass=15 fail=0
```
### t5
```
PASS  X1 | expected: rc!=0; 'do not match the reviewed values'; no bundle created | actual: rc=1; REFUSING: script hashes do not match the reviewed values; bundles=0
PASS  X2 | expected: rc!=0; 'usage'; no bundle created | actual: rc=1; REFUSING: usage: host_run; bundles=0
PASS  X3 | expected: rc!=0; 'too close to the 02:15 IST nightly'; no bundle created | actual: rc=1; REFUSING: it is 0215 IST: too close to the 02:15 IST nightly backup (allowed outside 01:45-03:30 IST); bundles=0
PASS  X3b 01:44 IST is outside the window (allowed; run proceeds) | expected: no 'too close' refusal | actual: rc=0
PASS  X4 | expected: rc!=0; 'exactly one BACKUP_PW='; no bundle created | actual: rc=1; REFUSING: /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t5_1752; bundles=0
PASS  X5 | expected: rc!=0; 'exactly one BACKUP_PW='; no bundle created | actual: rc=1; REFUSING: /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t5_1752; bundles=0
PASS  X6 | expected: rc!=0; 'BACKUP_PW is empty'; no bundle created | actual: rc=1; REFUSING: BACKUP_PW is empty; bundles=0
PASS  X7 | expected: rc!=0; 'not present locally'; no bundle created | actual: rc=1; REFUSING: image postgres:99-does-not-exist is not present locally (will not pull); bundles=0
PASS  X8 | expected: rc!=0; 'nightly backup directory'; no bundle created | actual: rc=1; REFUSING: refusing to write into the nightly backup directory; bundles=0
PASS  X9 wrong database password: container fails, nothing published, nonzero exit | expected: rc!=0; no bundle | actual: rc=1; bundles=0; FAILED: cannot connect
PASS  X10 | expected: rc!=0; 'do not match the reviewed values'; no bundle created | actual: rc=1; REFUSING: script hashes do not match the reviewed values; bundles=0
PASS  X11 success: rc=0, one new bundle, VERIFIED_BUNDLE printed | expected: rc=0; bundles=1; VERIFIED_BUNDLE | actual: rc=0; bundles=1; VERIFIED_BUNDLE C:/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7
PASS  X12 the database password appears nowhere in the stdout/log files | expected: absent | actual: searched stdout and 2 log file(s)
PASS  X13 the host_run output shows the image id and the reviewed-hash confirmation | expected: present | actual: image postgres:16-alpine = sha256:721873c34ceb; 1 hash line
PASS  X14 the bundle written by host_run.sh passes the local transferred-bundle verification | expected: rc=0 | actual: rc=0; BUNDLE VERIFIED (verify-only): no database was contacted.
PASS  X15 a failed pre-check never started a container: all refusals happened with 0 bundles and the staging dir is absent | expected: no .tmp-* | actual: 0 staging dirs
RESULT pass=16 fail=0
work dir: /c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/testlogs/t5_175203
```

## Final scripts (verbatim)
### snapshot_dump.sql
```
-- TRIVO snapshot-consistent dump + row-count manifest (READ-ONLY against the database).  Format: manifest v2.
-- Run (via run.sh) as the read-only, BYPASSRLS role trivo_backup so every company's rows are counted and dumped.
--
-- ONE REPEATABLE READ READ ONLY transaction exports its snapshot, counts every relation in the defined set, and stays OPEN while
-- pg_dump imports that very snapshot (--snapshot). COMMIT happens only after pg_dump exits. So manifest and dump describe the SAME
-- database snapshot by construction. The exported snapshot id is valid only while this transaction is open; if this session dies
-- the transaction aborts and the snapshot disappears with it.
--
-- Defined relation set: every ORDINARY table (pg_class.relkind = 'r') in schema "public".
-- Output goes ONLY into the private staging directory :outdir (created by run.sh): manifest.tsv (counts and catalog numbers
-- only - NO row data) and trivo_snap.dump. pg_dump's exit status goes to container-local /tmp/dump.rc.
--
-- Variables (required): outdir, expect_db, expect_user.   Optional: expect_major (default 16), hold (seconds; TEST HOOK, 0 in production).
\set ON_ERROR_STOP on
\if :{?hold}
\else
  \set hold 0
\endif
\if :{?expect_major}
\else
  \set expect_major 16
\endif
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '10s';
SET LOCAL idle_in_transaction_session_timeout = '2h';

\o /dev/null
SELECT set_config('trivo.expect_db', :'expect_db', true), set_config('trivo.expect_user', :'expect_user', true),
       set_config('trivo.expect_major', :'expect_major', true);
-- GUARDS. Fail closed: the first failing guard aborts the transaction with "GUARD_FAILED:<name>" and (ON_ERROR_STOP) psql exits non-zero,
-- so nothing is counted and no dump is started.
DO $guard$
DECLARE
  who pg_roles%ROWTYPE;
  bad text;
BEGIN
  IF current_database() <> current_setting('trivo.expect_db') THEN RAISE EXCEPTION 'GUARD_FAILED:database_is_expected'; END IF;
  IF current_user <> current_setting('trivo.expect_user') OR session_user <> current_setting('trivo.expect_user') THEN
    RAISE EXCEPTION 'GUARD_FAILED:role_is_expected'; END IF;
  SELECT * INTO who FROM pg_roles WHERE rolname = current_user;
  IF who.rolsuper THEN RAISE EXCEPTION 'GUARD_FAILED:role_is_not_superuser'; END IF;
  IF NOT who.rolbypassrls THEN RAISE EXCEPTION 'GUARD_FAILED:role_bypasses_rls'; END IF;
  IF (current_setting('server_version_num')::int / 10000) <> current_setting('trivo.expect_major')::int THEN
    RAISE EXCEPTION 'GUARD_FAILED:server_major_version_is_expected'; END IF;
  IF current_setting('transaction_read_only') <> 'on' THEN RAISE EXCEPTION 'GUARD_FAILED:transaction_is_read_only'; END IF;
  -- prove it, do not just read the flag: a write must be refused by the server
  BEGIN
    CREATE TEMP TABLE trivo_write_probe(x int);
    RAISE EXCEPTION 'GUARD_FAILED:transaction_rejects_writes';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r') THEN
    RAISE EXCEPTION 'GUARD_FAILED:relation_set_is_not_empty'; END IF;
  -- the manifest only describes schema public: refuse a database whose dump would contain tables it cannot describe
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('public','pg_catalog','information_schema') AND n.nspname !~ '^pg_toast') THEN
    RAISE EXCEPTION 'GUARD_FAILED:no_tables_outside_public'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND (c.relkind = 'p' OR c.relispartition)) THEN
    RAISE EXCEPTION 'GUARD_FAILED:no_partitioned_tables'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT has_table_privilege(current_user, c.oid, 'SELECT')) THEN
    RAISE EXCEPTION 'GUARD_FAILED:can_select_every_table'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'S' AND NOT has_sequence_privilege(current_user, c.oid, 'SELECT')) THEN
    RAISE EXCEPTION 'GUARD_FAILED:can_select_every_sequence'; END IF;
  -- the role is the read-only backup role: it holds no write privilege anywhere in public
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','S')
                AND (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE')
                     OR has_table_privilege(current_user, c.oid, 'DELETE') OR has_table_privilege(current_user, c.oid, 'TRUNCATE'))) THEN
    RAISE EXCEPTION 'GUARD_FAILED:role_has_no_write_privileges'; END IF;
  IF has_schema_privilege(current_user, 'public', 'CREATE') THEN RAISE EXCEPTION 'GUARD_FAILED:role_cannot_create_in_public'; END IF;
END
$guard$;
SELECT pg_export_snapshot() AS snap \gset
\o
\setenv SNAP :snap
\setenv OUTDIR :outdir
-- test hook only (hold=0 in production): widen the window so a concurrent writer can be proven NOT to leak into the snapshot
\o /dev/null
SELECT pg_sleep(:hold);
\o

\pset tuples_only on
\pset format unaligned
\pset fieldsep '\t'
\o :outdir/manifest.tsv
SELECT '#trivo-count-manifest', 'v2';
SELECT '#database', current_database();
SELECT '#server_version', current_setting('server_version');
SELECT '#snapshot_id', :'snap';
SELECT '#pg_snapshot', pg_current_snapshot()::text;
SELECT '#txn_start_utc', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SELECT '#relation_set', 'schema public; relkind r (ordinary tables)';
SELECT '#table_count', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';
-- catalog numbers of the same snapshot: the restore must reproduce them EXACTLY (RLS is the tenant boundary)
SELECT '#tenant_isolation_policies', count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation';
SELECT '#forced_rls_tables', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
SELECT '#composite_company_fks', count(*) FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) AND a.attname = 'companyId'
 WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 2;
SELECT format('SELECT %L, count(*) FROM %I.%I', c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname \gexec
SELECT '#end', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';
\o

-- pg_dump runs on the SAME snapshot while this transaction is still open. Its exit status is recorded (psql ignores it).
\! timeout 3600 pg_dump -Fc -Z 6 --no-owner --snapshot="$SNAP" -f "$OUTDIR/trivo_snap.dump"; echo $? > /tmp/dump.rc
COMMIT;
```
### run.sh
```
#!/bin/sh
# TRIVO production snapshot + manifest + dump, run INSIDE a postgres:16-alpine container. READ-ONLY against the database.
#
# Mounts:   /scripts  (read-only)  this file + snapshot_dump.sql          /out  (read-write)  the dedicated output directory
# Env:      PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD (+ optional PGSSLMODE)      EXPECT_DB EXPECT_USER   (mandatory guards)
#           EXPECT_PG_MAJOR (default 16: both the CLIENT tools in this container and the SERVER must be this major version)
#
# PUBLICATION MODEL (all-or-nothing):
#   1. A private staging directory /out/.tmp-<id> (mode 700, created with plain mkdir - it fails if the name exists) receives ALL
#      FOUR files: trivo_snap.dump, manifest.tsv, SNAPSHOT_OK (the success marker), SHA256SUMS.
#   2. Everything is generated and verified INSIDE that directory.
#   3. Only then is the whole directory published with ONE rename(2) to a unique, never-reused name /out/bundle-<id>.
#      Nothing is ever visible under a final name until all four files are complete and verified.
#   4. An existing bundle is never overwritten. A stale .tmp-* directory left by an earlier killed run is NEVER deleted
#      automatically: this script refuses to start while one exists, so the operator inspects it first (see RUNBOOK).
# On an ordinary failure or TERM/INT this run removes only ITS OWN staging directory (never anything from an earlier run).
set -eu
umask 077
: "${EXPECT_DB:?EXPECT_DB required}"; : "${EXPECT_USER:?EXPECT_USER required}"
EXPECT_PG_MAJOR="${EXPECT_PG_MAJOR:-16}"
BASE=/out
SQL=/scripts/snapshot_dump.sql
ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TMPD="$BASE/.tmp-$ID"
FINAL="$BASE/${TEST_FINAL_NAME:-bundle-$ID}"     # TEST_FINAL_NAME is a test hook; unset in production

# Test hooks (no effect unless the variable is set; the production command never sets them).
pause_at() { if [ "${TEST_PAUSE_AT:-}" = "$1" ]; then echo "PAUSED at $1"; sleep 3600 & wait $!; fi; return 0; }
fail_at()  { if [ "${TEST_FAIL_AT:-}" = "$1" ]; then echo "TEST-INJECTED FAILURE at $1"; exit 1; fi; return 0; }

# Test-only corruption hooks (inert unless TEST_MUTATE is set): used by the local failure-injection tests, never by production.
mutate() { # mutate STAGE   (run inside the staging directory)
  [ "${TEST_MUTATE_AT:-}" = "$1" ] || return 0
  case "${TEST_MUTATE:-}" in
    truncate_dump)       head -c 4096 trivo_snap.dump > t.tmp && mv t.tmp trivo_snap.dump;;
    drop_manifest_row)   awk -F'	' 'BEGIN{d=0} /^#/{print;next} d==0{d=1;next} {print}' manifest.tsv > t.tmp && mv t.tmp manifest.tsv;;
    dup_manifest_row)    awk -F'	' 'BEGIN{d=0} /^#end/{ if(first!="") print first } {print} !/^#/ && first==""{first=$0}' manifest.tsv > t.tmp && mv t.tmp manifest.tsv;;
    bad_manifest_header) sed -i 's/^#trivo-count-manifest	v2$/#trivo-count-manifest	v9/' manifest.tsv;;
    rename_table)        sed -i 's/^accounts	/accountz	/' manifest.tsv;;
    flip_dump)           printf 'X' >> trivo_snap.dump;;
    *) echo "unknown TEST_MUTATE"; exit 1;;
  esac
  echo "TEST-MUTATION $TEST_MUTATE applied at $1"
}

CREATED=0; PUBLISHED=0
cleanup() {
  rc=$?
  trap '' TERM INT
  rm -f /tmp/dump.rc /tmp/toc.txt /tmp/man.txt /tmp/toc_hdr.txt
  if [ "$CREATED" = 1 ] && [ -d "$TMPD" ]; then rm -rf "$TMPD"; fi      # only THIS run's own staging directory
  if [ "$rc" != 0 ]; then
    if [ "$PUBLISHED" = 1 ]; then echo "WARNING (exit $rc): bundle $FINAL WAS published but the final re-verification failed - treat it as UNVERIFIED"
    else echo "FAILED (exit $rc): this run's staging directory was removed; nothing was published"; fi
  fi
}
# TERM/INT: stop every child (psql, its pg_dump) first, give them a moment to exit, then the EXIT trap cleans our own staging dir.
on_signal() { trap '' TERM INT; kill -TERM 0 2>/dev/null || true; sleep 1; exit "$1"; }
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap cleanup EXIT

echo "client tools: $(psql --version | head -1) | $(pg_dump --version | head -1)"
for tool in psql pg_dump pg_restore; do
  v="$($tool --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')"
  [ "$v" = "$EXPECT_PG_MAJOR" ] || { echo "REFUSING: $tool is major version $v, expected $EXPECT_PG_MAJOR (client and server must match)"; exit 1; }
done

# One run at a time (the lock is released automatically when the process dies, however it dies).
exec 9>"$BASE/.run.lock"
flock -n 9 || { echo "REFUSING: another run holds $BASE/.run.lock"; exit 1; }

# Refuse to start if an earlier run left a staging directory: it may hold a partial dump of customer data and is evidence.
STALE="$(find "$BASE" -maxdepth 1 -name '.tmp-*' | sort)"
if [ -n "$STALE" ]; then
  echo "REFUSING: stale staging director(y/ies) from an earlier interrupted run exist. NOTHING was deleted or changed."
  echo "Inspect them, then remove them yourself if appropriate:"; echo "$STALE"
  exit 1
fi
[ ! -e "$FINAL" ] || { echo "REFUSING: $FINAL already exists (will not overwrite)"; exit 1; }

# Cheap identity + disk preflight (still read-only; the SQL guards below remain authoritative).
IDENT="$(psql -v ON_ERROR_STOP=1 -Atq -c "select current_database()||'|'||current_user||'|'||pg_database_size(current_database())")" || { echo "FAILED: cannot connect"; exit 1; }
[ "${IDENT%%|*}" = "$EXPECT_DB" ] || { echo "REFUSING: connected database is not the expected one"; exit 1; }
rest="${IDENT#*|}"; [ "${rest%%|*}" = "$EXPECT_USER" ] || { echo "REFUSING: connected role is not the expected one"; exit 1; }
DBBYTES="${rest#*|}"
FREEKB="$(df -Pk "$BASE" | awk 'NR==2{print $4}')"
NEEDKB=$(( (DBBYTES / 1024) * 2 + 102400 ))
[ "$FREEKB" -ge "$NEEDKB" ] || { echo "REFUSING: only ${FREEKB} KB free in $BASE, need at least ${NEEDKB} KB (2x database size + 100 MB)"; exit 1; }
echo "preflight ok: database size ${DBBYTES} bytes, ${FREEKB} KB free"

# The backup role is limited to 3 connections and this run needs 2 (psql + pg_dump). No OTHER session of the role may be active:
# an overlapping nightly dump (or a lingering session of an earlier killed run) would make pg_dump fail AFTER the snapshot was taken.
i=0
while :; do
  n="$(psql -v ON_ERROR_STOP=1 -Atq -c "select count(*) from pg_stat_activity where usename = current_user and backend_type = 'client backend' and pid <> pg_backend_pid()")" || { echo "FAILED: cannot connect"; exit 1; }
  [ "$n" = 0 ] && break
  i=$((i+1)); [ "$i" -le 20 ] || { echo "REFUSING: $n other session(s) of role $EXPECT_USER are active (a backup running? an earlier killed run still closing?)"; exit 1; }
  sleep 1
done

mkdir -m 700 "$TMPD"; CREATED=1
pause_at after_mkdir; fail_at after_mkdir

rm -f /tmp/dump.rc
psql -v ON_ERROR_STOP=1 -v hold="${HOLD:-0}" -v outdir="$TMPD" -v expect_db="$EXPECT_DB" -v expect_user="$EXPECT_USER" -v expect_major="$EXPECT_PG_MAJOR" -f "$SQL" &
wait $!
pause_at after_dump
[ -f /tmp/dump.rc ] && [ "$(cat /tmp/dump.rc)" = 0 ] || { echo "FAILED: pg_dump did not exit 0 (rc=$(cat /tmp/dump.rc 2>/dev/null || echo none))"; exit 1; }

cd "$TMPD"
mutate after_dump
[ -s trivo_snap.dump ] && [ -s manifest.tsv ] || { echo "FAILED: dump or manifest missing/empty"; exit 1; }
pg_restore -l trivo_snap.dump > /tmp/toc.txt || { echo "FAILED: dump is not readable"; exit 1; }
# manifest sanity (structure only; the restore side re-validates strictly)
grep -q '^#trivo-count-manifest	v2$' manifest.tsv || { echo "FAILED: manifest header"; exit 1; }
n=$(grep -vc '^#' manifest.tsv); e=$(grep '^#end	' manifest.tsv | cut -f2); t=$(grep '^#table_count	' manifest.tsv | cut -f2)
[ "$n" -ge 1 ] && [ "$n" = "$e" ] && [ "$n" = "$t" ] || { echo "FAILED: manifest has $n rows, table_count=$t, end=$e"; exit 1; }
[ "$(cut -f1 manifest.tsv | grep -v '^#' | sort | uniq -d | wc -l)" = 0 ] || { echo "FAILED: duplicate table in manifest"; exit 1; }
# the dump's own table list must equal the manifest's table list
awk '$4=="TABLE" && $5=="DATA" && $6=="public"{print $7}' /tmp/toc.txt | sort > /tmp/toc_tables.txt
grep -v '^#' manifest.tsv | cut -f1 | sort > /tmp/man.txt
cmp -s /tmp/toc_tables.txt /tmp/man.txt || { echo "FAILED: dump table list differs from manifest table list"; exit 1; }
rm -f /tmp/toc_tables.txt
# the dump's own header must agree with the manifest (same database, same server)
mdb="$(grep '^#database	' manifest.tsv | cut -f2)"; msv="$(grep '^#server_version	' manifest.tsv | cut -f2)"
grep -qE "^; +dbname: ${mdb}\$" /tmp/toc.txt || { echo "FAILED: dump header database differs from manifest"; exit 1; }
grep -qE "^; +Dumped from database version: ${msv}( |\$)" /tmp/toc.txt || { echo "FAILED: dump header server version differs from manifest"; exit 1; }
pause_at validated

# success marker: binds the dump to the manifest (same snapshot id, hashes of both) and records the client that produced it
DSHA="$(sha256sum trivo_snap.dump | cut -d' ' -f1)"; MSHA="$(sha256sum manifest.tsv | cut -d' ' -f1)"
DBYTES="$(wc -c < trivo_snap.dump | tr -d ' ')"
{
  printf '#trivo-snapshot-ok\tv1\n'
  printf 'database\t%s\n' "$mdb"
  printf 'server_version\t%s\n' "$msv"
  printf 'snapshot_id\t%s\n' "$(grep '^#snapshot_id	' manifest.tsv | cut -f2)"
  printf 'table_count\t%s\n' "$n"
  printf 'dump_file\ttrivo_snap.dump\n'
  printf 'dump_bytes\t%s\n' "$DBYTES"
  printf 'dump_sha256\t%s\n' "$DSHA"
  printf 'manifest_sha256\t%s\n' "$MSHA"
  printf 'pg_dump_version\t%s\n' "$(pg_dump --version | sed -E 's/.* ([0-9][0-9.]*).*/\1/')"
  printf 'completed_utc\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '#end\tok\n'
} > SNAPSHOT_OK

fail_at checksum
sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS
mutate after_sums
sha256sum -c SHA256SUMS
chmod 600 trivo_snap.dump manifest.tsv SNAPSHOT_OK SHA256SUMS
pause_at checksummed

# the bundle must contain exactly the four expected files
[ "$(ls -A "$TMPD" | sort | tr '\n' ' ')" = "SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump " ] || { echo "FAILED: unexpected bundle contents: $(ls -A "$TMPD")"; exit 1; }
cd "$BASE"
fail_at rename
[ ! -e "$FINAL" ] || { echo "REFUSING: $FINAL already exists (will not overwrite)"; exit 1; }
mv -T "$TMPD" "$FINAL"          # ONE rename(2): the complete, verified directory appears under its final name atomically
PUBLISHED=1
pause_at renamed

( cd "$FINAL" && sha256sum -c SHA256SUMS )
echo "BUNDLE_OK $FINAL tables=$n"
```
### host_run.sh
```
#!/usr/bin/env bash
# TRIVO production snapshot - HOST-SIDE driver. Run as root ON THE PRODUCTION HOST, only after the operator has uploaded the reviewed
# scripts and verified their SHA-256 (see RUNBOOK.md). Writes ONLY inside the dedicated output directory.
#
#   ./host_run.sh <sha256-of-run.sh> <sha256-of-snapshot_dump.sql> <sha256-of-bundle_postcheck.sh>
#
# Steps: refuse if anything is off -> read the backup password WITHOUT printing it -> run the approved postgres:16-alpine container
# (only the database connection and the output directory are reachable) -> independently re-verify the published bundle
# (directory/file permissions, exact file set, checksums, manifest, success marker) -> print the bundle path + hashes.
# It never deletes anything, never touches the nightly backup directory, never connects to any database other than trivo_prod
# (the SQL guards also refuse any role other than trivo_backup).
set -euo pipefail
umask 077

OUT="${TRIVO_VERIFY_OUT:-/var/backups/trivo-prod-verify}"           # the dedicated output directory (production default)
SCRIPTS="$OUT/scripts"
ENV_FILE="${TRIVO_VERIFY_ENV_FILE:-/opt/trivo-prod/.env}"
NET="${TRIVO_VERIFY_NETWORK-trivoprod_default}"
IMAGE="${TRIVO_VERIFY_IMAGE:-postgres:16-alpine}"                    # the same image the nightly backup uses
PGHOST_="${TRIVO_VERIFY_PGHOST:-postgres}"; PGPORT_="${TRIVO_VERIFY_PGPORT:-5432}"
EXPECT_DB=trivo_prod; EXPECT_USER=trivo_backup                       # NOT overridable
EXTRA_DOCKER_ARGS=( ${TRIVO_VERIFY_EXTRA_DOCKER_ARGS:-} )            # tests only (e.g. --add-host); empty in production

die() { echo "REFUSING: $*" >&2; exit 1; }
case "$OUT" in /var/backups/trivo-prod|/var/backups/trivo-prod/*|/) die "refusing to write into the nightly backup directory";; esac
[ "$#" = 3 ] || die "usage: host_run.sh <sha256 of run.sh> <sha256 of snapshot_dump.sql> <sha256 of bundle_postcheck.sh>"
[ "$(id -u)" = 0 ] || [ "${TRIVO_VERIFY_TEST:-}" = 1 ] || die "must run as root"

# 1. the scripts about to run are exactly the reviewed ones
[ -d "$SCRIPTS" ] || die "$SCRIPTS does not exist"
printf '%s  %s\n%s  %s\n%s  %s\n' "$1" "$SCRIPTS/run.sh" "$2" "$SCRIPTS/snapshot_dump.sql" "$3" "$SCRIPTS/bundle_postcheck.sh" | sha256sum -c - >/dev/null || die "script hashes do not match the reviewed values"
echo "script hashes match the reviewed values"

# 2. output directory: root-owned, mode 700, nothing but our own artefacts
perm() { stat -c '%a %U' "$1"; }
if [ "${TRIVO_VERIFY_TEST:-}" != 1 ]; then
  [ "$(perm "$OUT")" = "700 root" ] || die "$OUT must be mode 700 owned by root (found: $(perm "$OUT"))"
  [ "$(perm "$SCRIPTS")" = "700 root" ] || die "$SCRIPTS must be mode 700 owned by root (found: $(perm "$SCRIPTS"))"
fi

# 3. not near the nightly backup (02:15 IST = 20:45 UTC) and no backup job running
if [ -n "${TEST_NOW_HHMM_IST:-}" ]; then NOW="$TEST_NOW_HHMM_IST"; else NOW="$(TZ=Asia/Kolkata date +%H%M)"; fi
NOWM=$(( 10#${NOW:0:2} * 60 + 10#${NOW:2:2} ))
if [ "$NOWM" -ge $((1*60+45)) ] && [ "$NOWM" -le $((3*60+30)) ]; then die "it is $NOW IST: too close to the 02:15 IST nightly backup (allowed outside 01:45-03:30 IST)"; fi
if command -v systemctl >/dev/null 2>&1; then
  [ "$(systemctl is-active trivoprod-backup.service 2>/dev/null || true)" != active ] || die "trivoprod-backup.service is running right now"
elif [ "${TRIVO_VERIFY_TEST:-}" != 1 ]; then die "systemctl not found: cannot confirm the nightly backup is idle"; fi
if pgrep -f 'scripts/backup.sh|pg_dump' >/dev/null 2>&1; then die "a backup / pg_dump process is already running on this host"; fi

# 4. image: must already be present locally (never pulled); record its id
IMGID="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null)" || die "image $IMAGE is not present locally (will not pull)"
echo "image $IMAGE = $IMGID"

# 5. the backup password: read from the env file without printing it; passed to the container by NAME only (never on a command line)
[ -r "$ENV_FILE" ] || die "$ENV_FILE not readable"
[ "$(grep -c '^BACKUP_PW=' "$ENV_FILE")" = 1 ] || die "$ENV_FILE must contain exactly one BACKUP_PW= line"
PGPASSWORD="$(grep '^BACKUP_PW=' "$ENV_FILE" | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']\$//")"
[ -n "$PGPASSWORD" ] || die "BACKUP_PW is empty"
export PGPASSWORD

# 6. run
BEFORE="$(ls -1A "$OUT" | grep -c '^bundle-' || true)"
echo "== running snapshot container (database $EXPECT_DB as $EXPECT_USER via $PGHOST_:$PGPORT_) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker run --rm --pull never --name "trivo_verify_snapshot_$$" \
  ${NET:+--network "$NET"} "${EXTRA_DOCKER_ARGS[@]}" \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --memory 1g \
  -v "$SCRIPTS:/scripts:ro" -v "$OUT:/out" \
  -e PGHOST="$PGHOST_" -e PGPORT="$PGPORT_" -e PGUSER="$EXPECT_USER" -e PGDATABASE="$EXPECT_DB" -e PGPASSWORD \
  -e EXPECT_DB="$EXPECT_DB" -e EXPECT_USER="$EXPECT_USER" -e EXPECT_PG_MAJOR=16 \
  "$IMAGE" sh /scripts/run.sh 2>&1 | tee -a "$OUT/run-$(date -u +%Y%m%dT%H%M%SZ).log"
rc="${PIPESTATUS[0]}"; unset PGPASSWORD
[ "$rc" = 0 ] || { echo "FAILED: container exit $rc. Nothing was published. See RUNBOOK.md 'Failure recovery'." >&2; exit "$rc"; }

# 7. independent re-verification of the bundle that was just published (permissions, exact file set, checksums, marker, manifest)
AFTER="$(ls -1A "$OUT" | grep -c '^bundle-' || true)"
[ "$AFTER" = $((BEFORE+1)) ] || die "expected exactly one new bundle (before=$BEFORE after=$AFTER)"
B="$OUT/$(ls -1At "$OUT" | grep '^bundle-' | head -1)"
if [ "${TRIVO_VERIFY_TEST:-}" = 1 ]; then echo "(TEST mode: file-mode checks skipped here; bundle_postcheck.sh is tested separately on Linux)"
  ( cd "$B" && sha256sum -c SHA256SUMS ) || die "checksum verification FAILED"
else bash "$SCRIPTS/bundle_postcheck.sh" "$B" "$EXPECT_DB" || die "post-check failed for $B"; fi
echo
echo "VERIFIED_BUNDLE $B"
ls -l "$B"
echo "SHA256SUMS content (compare these three lines on the operator console after transfer):"; cat "$B/SHA256SUMS"
echo "sha256 of SHA256SUMS itself: $(sha256sum "$B/SHA256SUMS" | cut -d' ' -f1)"
```
### bundle_postcheck.sh
```
#!/usr/bin/env bash
# Independent, database-free re-verification of a published snapshot bundle, run ON THE PRODUCTION HOST (Linux, as root) after
# run.sh published it. Read-only: it only inspects. Usage: bundle_postcheck.sh <bundle-dir> <expected-database>
# Checks: directory mode 700 and every file mode 600, all owned by root; exactly the four expected regular files; sha256 of each file
# against SHA256SUMS; success marker and manifest complete and naming the expected database; marker hashes equal the real file hashes.
set -euo pipefail
B="${1:?bundle dir}"; DB="${2:?expected database}"
die() { echo "POSTCHECK FAILED: $*" >&2; exit 1; }
[ -d "$B" ] && [ ! -L "$B" ] || die "$B is not a real directory"
[ "$(stat -c '%a %U' "$B")" = "700 root" ] || die "bundle directory must be mode 700 owned by root (found $(stat -c '%a %U' "$B"))"
[ "$(ls -A "$B" | LC_ALL=C sort | tr '\n' ' ')" = "SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump " ] || die "bundle does not contain exactly the four expected files"
for f in SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump; do
  [ -f "$B/$f" ] && [ ! -L "$B/$f" ] || die "$f is not a regular file"
  [ "$(stat -c '%a %U' "$B/$f")" = "600 root" ] || die "$f must be mode 600 owned by root (found $(stat -c '%a %U' "$B/$f"))"
done
[ "$(awk 'END{print NR}' "$B/SHA256SUMS")" = 3 ] || die "SHA256SUMS must have exactly 3 lines"
( cd "$B" && sha256sum -c SHA256SUMS ) || die "checksum verification failed"
[ "$(head -1 "$B/SNAPSHOT_OK")" = "$(printf '#trivo-snapshot-ok\tv1')" ] && [ "$(tail -1 "$B/SNAPSHOT_OK")" = "$(printf '#end\tok')" ] || die "success marker is missing or incomplete"
[ "$(head -1 "$B/manifest.tsv")" = "$(printf '#trivo-count-manifest\tv2')" ] && [ "$(tail -1 "$B/manifest.tsv" | cut -f1)" = '#end' ] || die "manifest is incomplete"
mk() { grep "^$1"$'\t' "$B/SNAPSHOT_OK" | cut -f2; }
[ "$(mk database)" = "$DB" ] || die "marker names a different database"
[ "$(mk dump_sha256)" = "$(sha256sum "$B/trivo_snap.dump" | cut -d' ' -f1)" ] || die "marker dump_sha256 differs from the dump"
[ "$(mk manifest_sha256)" = "$(sha256sum "$B/manifest.tsv" | cut -d' ' -f1)" ] || die "marker manifest_sha256 differs from the manifest"
[ "$(mk table_count)" = "$(grep -vc '^#' "$B/manifest.tsv")" ] || die "marker table_count differs from the manifest"
echo "POSTCHECK OK $B tables=$(mk table_count) server=$(mk server_version) snapshot=$(mk snapshot_id)"
```
### manifest_check.sh
```
# Strict bundle + row-count manifest checking for restore verification. SOURCED by restore-manifest.sh; defines functions only.
#
# Bundle (directory produced by run.sh) = exactly four files:  trivo_snap.dump  manifest.tsv  SNAPSHOT_OK  SHA256SUMS
#
# manifest.tsv, format v2 (tab separated, LF only), produced by snapshot_dump.sql:
#   #trivo-count-manifest <TAB> v2                      (exactly the first line)
#   #database | #server_version | #snapshot_id | #pg_snapshot | #txn_start_utc | #relation_set | #table_count |
#   #tenant_isolation_policies | #forced_rls_tables | #composite_company_fks                         (each exactly once)
#   <table> <TAB> <count>                               (one per table; unique)
#   #end <TAB> <N>                                      (exactly once, the LAST line)
# SNAPSHOT_OK (success marker; binds the dump to the manifest):
#   #trivo-snapshot-ok <TAB> v1 / database / server_version / snapshot_id / table_count / dump_file / dump_bytes / dump_sha256 /
#   manifest_sha256 / pg_dump_version / completed_utc / #end <TAB> ok
# Fails CLOSED: any deviation is an error (never a skipped check). Prints counts and table names only - never row data.

MANIFEST_RELATION_SET='schema public; relkind r (ordinary tables)'
BUNDLE_FILES='SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump'
MANIFEST_HEADERS='#database #server_version #snapshot_id #pg_snapshot #txn_start_utc #relation_set #table_count #tenant_isolation_policies #forced_rls_tables #composite_company_fks #end'

mhdr() { awk -F'\t' -v k="$2" '$1==k{print $2; exit}' "$1"; }   # mhdr FILE '#key' -> value

# validate_manifest FILE -> 0 if structurally valid; otherwise prints every problem and returns 1.
validate_manifest() {
  local f="$1" bad=0 k n
  merr() { echo "  manifest: $*"; bad=1; }
  [ -s "$f" ] || { merr "missing or empty"; return 1; }
  if [ "$(LC_ALL=C tr -cd '\r' < "$f" | wc -c)" -gt 0 ]; then merr "contains CR characters (must be LF-only; was it edited or transferred in text mode?)"; fi
  [ "$(head -n1 "$f")" = $'#trivo-count-manifest\tv2' ] || merr "first line is not '#trivo-count-manifest<TAB>v2'"
  [ "$(tail -n1 "$f" | cut -f1)" = '#end' ] || merr "last line is not '#end' (truncated?)"
  for k in $MANIFEST_HEADERS; do
    n=$(awk -F'\t' -v k="$k" '$1==k{c++} END{print c+0}' "$f")
    [ "$n" = 1 ] || merr "header '$k' appears $n times (expected exactly 1)"
  done
  local unknown; unknown=$(awk -F'\t' '/^#/{print $1}' "$f" | sort -u | grep -vxE "#trivo-count-manifest|$(echo $MANIFEST_HEADERS | tr ' ' '|')" || true)
  [ -z "$unknown" ] || merr "unknown header line(s): $(echo $unknown)"
  [ "$(mhdr "$f" '#relation_set')" = "$MANIFEST_RELATION_SET" ] || merr "#relation_set is not the expected definition"
  [[ "$(mhdr "$f" '#database')" =~ ^[A-Za-z0-9_]+$ ]] || merr "#database is not a plain identifier"
  [[ "$(mhdr "$f" '#server_version')" =~ ^[0-9]+(\.[0-9]+)*$ ]] || merr "#server_version is malformed"
  [[ "$(mhdr "$f" '#snapshot_id')" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || merr "#snapshot_id is malformed"
  [[ "$(mhdr "$f" '#txn_start_utc')" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || merr "#txn_start_utc is malformed"
  [[ "$(mhdr "$f" '#pg_snapshot')" =~ ^[0-9]+:[0-9]+:[0-9,]*$ ]] || merr "#pg_snapshot is malformed"
  for k in '#tenant_isolation_policies' '#forced_rls_tables' '#composite_company_fks'; do
    [[ "$(mhdr "$f" "$k")" =~ ^[0-9]+$ ]] || merr "$k is not a non-negative integer"
  done
  # data lines
  local rows; rows=$(grep -vc '^#' "$f" || true)
  if awk -F'\t' '!/^#/ && (NF!=2 || $1 !~ /^[A-Za-z_][A-Za-z0-9_]*$/ || $2 !~ /^[0-9]+$/){ bad=1; print "  manifest: malformed data line " NR " (need <table><TAB><non-negative integer>)" } END{exit bad}' "$f"; then :; else bad=1; fi
  local dups; dups=$(awk -F'\t' '!/^#/{print $1}' "$f" | sort | uniq -d | tr '\n' ' ')
  [ -z "$dups" ] || merr "duplicate table(s): $dups"
  [ "$rows" -ge 1 ] || merr "no table rows"
  local tc en
  tc=$(mhdr "$f" '#table_count'); en=$(mhdr "$f" '#end')
  [[ "$tc" =~ ^[0-9]+$ ]] && [ "$tc" = "$rows" ] || merr "#table_count=$tc but $rows table rows present"
  [[ "$en" =~ ^[0-9]+$ ]] && [ "$en" = "$rows" ] || merr "#end=$en but $rows table rows present"
  [ "$bad" = 0 ]
}

# validate_marker FILE -> structural check of SNAPSHOT_OK
validate_marker() {
  local f="$1" bad=0 k n
  kerr() { echo "  marker: $*"; bad=1; }
  [ -s "$f" ] || { kerr "missing or empty"; return 1; }
  if [ "$(LC_ALL=C tr -cd '\r' < "$f" | wc -c)" -gt 0 ]; then kerr "contains CR characters"; fi
  [ "$(head -n1 "$f")" = $'#trivo-snapshot-ok\tv1' ] || kerr "first line is not '#trivo-snapshot-ok<TAB>v1'"
  [ "$(tail -n1 "$f")" = $'#end\tok' ] || kerr "last line is not '#end<TAB>ok' (truncated?)"
  for k in database server_version snapshot_id table_count dump_file dump_bytes dump_sha256 manifest_sha256 pg_dump_version completed_utc; do
    n=$(awk -F'\t' -v k="$k" '$1==k{c++} END{print c+0}' "$f")
    [ "$n" = 1 ] || kerr "'$k' appears $n times (expected exactly 1)"
  done
  [ "$(awk 'END{print NR}' "$f")" = 12 ] || kerr "unexpected number of lines (expected 12)"
  [ "$(mhdr "$f" dump_file)" = trivo_snap.dump ] || kerr "dump_file is not trivo_snap.dump"
  [[ "$(mhdr "$f" dump_sha256)" =~ ^[0-9a-f]{64}$ ]] || kerr "dump_sha256 is malformed"
  [[ "$(mhdr "$f" manifest_sha256)" =~ ^[0-9a-f]{64}$ ]] || kerr "manifest_sha256 is malformed"
  [ "$bad" = 0 ]
}

# verify_bundle DIR -> everything that can be proven about a transferred bundle WITHOUT any database:
#   exact file set; SHA256SUMS covers exactly the three data files and every hash matches; manifest valid; marker valid and bound to
#   the manifest (same snapshot id/database/version/table count/hashes); the dump is readable and its table list, database name and
#   server version equal the manifest's. Needs pg_restore (any version >= the dump's) on PATH.
verify_bundle() {
  local d="$1" bad=0 f
  berr() { echo "  bundle: $*"; bad=1; }
  [ -d "$d" ] || { echo "  bundle: not a directory: $d"; return 1; }
  local have; have=$(cd "$d" && ls -A | LC_ALL=C sort | tr '\n' ' ')
  [ "$have" = "$(echo $BUNDLE_FILES | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ' ')" ] || { berr "unexpected contents: [$have] (expected exactly: $BUNDLE_FILES)"; return 1; }
  for f in $BUNDLE_FILES; do [ -f "$d/$f" ] && [ ! -L "$d/$f" ] || berr "$f is not a regular file"; done
  [ "$bad" = 0 ] || return 1
  # SHA256SUMS: exactly the three data files, nothing else, every hash a real sha256, then verify
  # (a leading '*' on a name is sha256sum's own binary-mode marker, written by Windows builds of sha256sum; the name itself is still compared exactly)
  local listed; listed=$(awk '{n=$2; sub(/^\*/,"",n); print n}' "$d/SHA256SUMS" | LC_ALL=C sort | tr '\n' ' ')
  [ "$listed" = "SNAPSHOT_OK manifest.tsv trivo_snap.dump " ] || berr "SHA256SUMS lists [$listed], expected exactly SNAPSHOT_OK manifest.tsv trivo_snap.dump"
  [ "$(awk 'END{print NR}' "$d/SHA256SUMS")" = 3 ] || berr "SHA256SUMS does not have exactly 3 lines"
  awk '!($1 ~ /^[0-9a-f]{64}$/ && NF==2){exit 1}' "$d/SHA256SUMS" || berr "SHA256SUMS has a malformed line"
  [ "$bad" = 0 ] || return 1
  ( cd "$d" && sha256sum -c SHA256SUMS ) || { berr "checksum verification FAILED"; return 1; }
  validate_manifest "$d/manifest.tsv" || return 1
  validate_marker "$d/SNAPSHOT_OK" || return 1
  local k
  for k in database server_version snapshot_id table_count; do
    local mk="#$k"; [ "$(mhdr "$d/SNAPSHOT_OK" "$k")" = "$(mhdr "$d/manifest.tsv" "$mk")" ] || berr "marker $k differs from the manifest (not the same snapshot)"
  done
  [ "$(mhdr "$d/SNAPSHOT_OK" manifest_sha256)" = "$(sha256sum "$d/manifest.tsv" | cut -d' ' -f1)" ] || berr "marker manifest_sha256 differs from manifest.tsv"
  [ "$(mhdr "$d/SNAPSHOT_OK" dump_sha256)" = "$(sha256sum "$d/trivo_snap.dump" | cut -d' ' -f1)" ] || berr "marker dump_sha256 differs from trivo_snap.dump"
  [ "$(mhdr "$d/SNAPSHOT_OK" dump_bytes)" = "$(wc -c < "$d/trivo_snap.dump" | tr -d ' ')" ] || berr "marker dump_bytes differs from trivo_snap.dump"
  [ "$bad" = 0 ] || return 1
  # the dump itself
  local toc; toc=$(cd "$d" && pg_restore -l trivo_snap.dump | tr -d '\r') || { berr "dump is not readable by pg_restore"; return 1; }
  local only_d only_m
  only_d=$(comm -23 <(echo "$toc" | awk '$4=="TABLE" && $5=="DATA" && $6=="public"{print $7}' | LC_ALL=C sort) <(awk -F'\t' '!/^#/{print $1}' "$d/manifest.tsv" | LC_ALL=C sort) | tr '\n' ' ')
  only_m=$(comm -13 <(echo "$toc" | awk '$4=="TABLE" && $5=="DATA" && $6=="public"{print $7}' | LC_ALL=C sort) <(awk -F'\t' '!/^#/{print $1}' "$d/manifest.tsv" | LC_ALL=C sort) | tr '\n' ' ')
  [ -z "$only_d" ] || berr "table(s) in the dump but not in the manifest: $only_d"
  [ -z "$only_m" ] || berr "table(s) in the manifest but not in the dump: $only_m"
  grep -qE "^; +dbname: $(mhdr "$d/manifest.tsv" '#database')\$" <<< "$toc" || berr "dump header database differs from the manifest"
  grep -qE "^; +Dumped from database version: $(mhdr "$d/manifest.tsv" '#server_version')( |\$)" <<< "$toc" || berr "dump header server version differs from the manifest"
  [ "$bad" = 0 ]
}

# compare_manifest FILE VERIFY_URL -> compares STRICTLY against the restored database (read through a role that bypasses RLS):
# identical table set and an identical count in every table. VERIFY_URL is the restored scratch database.
# Needs a `psql` that prints unaligned/tuples-only (-Atq) and strips CR (restore-manifest.sh's wrapper does).
compare_manifest() {
  local f="$1" url="$2" bad=0
  validate_manifest "$f" || return 1
  local restored; restored=$(psql "$url" -Atq -c "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1") || { echo "  manifest: cannot read the restored database"; return 1; }
  local only_m only_r
  only_m=$(comm -23 <(awk -F'\t' '!/^#/{print $1}' "$f" | LC_ALL=C sort) <(echo "$restored" | LC_ALL=C sort) | tr '\n' ' ')
  only_r=$(comm -13 <(awk -F'\t' '!/^#/{print $1}' "$f" | LC_ALL=C sort) <(echo "$restored" | LC_ALL=C sort) | tr '\n' ' ')
  [ -z "$only_m" ] || { echo "  FAIL: table(s) in the manifest but NOT in the restored database: $only_m"; bad=1; }
  [ -z "$only_r" ] || { echo "  FAIL: table(s) in the restored database but NOT in the manifest: $only_r"; bad=1; }
  local t a b n=0 mism=0
  while IFS=$'\t' read -r t a; do
    case "$t" in '#'*) continue;; esac
    b=$(psql "$url" -Atq -c "select count(*) from public.\"$t\"" 2>/dev/null || echo ERR)
    n=$((n+1)); if [ "$a" != "$b" ]; then echo "  FAIL: row count differs in $t: manifest=$a restored=$b"; mism=1; fi
  done < "$f"
  [ "$mism" = 0 ] || bad=1
  [ "$bad" = 0 ] && echo "  ok:   row counts identical to the snapshot manifest in all $n tables (table sets identical)"
  [ "$bad" = 0 ]
}
```
### restore-manifest.sh
```
#!/usr/bin/env bash
# TRIVO restore + verification of a snapshot BUNDLE (produced by run.sh) into a NEW scratch database on a LOCAL PostgreSQL instance.
# Isolated sibling of server/scripts/restore.sh (which is unchanged): same verification steps, but row counts come ONLY from the
# bundle's manifest (same snapshot as the dump), the bundle is verified BEFORE any database exists, and every connection is proven to
# reach the intended local instance.
#
#   restore-manifest.sh --verify-only <bundle-dir>          verify the bundle's files/checksums/manifest/marker/dump; touches NO database
#   restore-manifest.sh <bundle-dir> [scratch-db-name]      verify, then restore + verify into a NEW scratch database
#
# Required environment for the restore form (no secrets are echoed):
#   ADMIN_DATABASE_URL            postgresql://postgres:...@localhost:PORT/postgres         (superuser: CREATE DATABASE, identity check)
#   OWNER_DATABASE_URL            postgresql://trivo_owner:...@localhost:PORT/postgres      (restores + re-applies db-secure.sql)
#   SOURCE_DATABASE_URL           postgresql://trivo_backup:...@localhost:PORT/postgres     (BYPASSRLS credential TEMPLATE only: its database
#                                                                                           name is swapped for the scratch database;
#                                                                                           the source/production database is never contacted)
#   RUNTIME_DATABASE_URL_TEMPLATE postgresql://trivo_runtime:...@localhost:PORT/__DB__      (proves tenant isolation as the real runtime role)
#   RESTORE_EXPECT_PORT           the one TCP port of the intended local instance
#   RESTORE_EXPECT_SYSTEM_IDENTIFIER  that instance's pg_control_system().system_identifier (a tunnel to production cannot match it)
# Optional: OWNER_ROLE (default trivo_owner), PG_BIN (directory with psql/pg_restore), DB_SECURE_SQL, RESTORE_JOBS (ignored: restore is serial).
#
# A failed restore or verification KEEPS the scratch database for investigation. This script never drops or overwrites any database.
# Exit code is non-zero if anything fails.

set -euo pipefail
[ -z "${PG_BIN:-}" ] || PATH="$PG_BIN:$PATH"
# (Windows psql emits CRLF; harmless elsewhere, and it would otherwise poison every comparison below.)
psql() { command psql "$@" | tr -d '\r'; }
strip_prisma() { echo "$1" | sed -E 's/([?&])(schema|connection_limit|pool_timeout|connect_timeout|sslaccept|pgbouncer)=[^&]*&?/\1/g; s/[?&]$//'; }
swap_db() { echo "$1" | sed -E "s#/[^/?]+(\?|\$)#/$2\1#"; }
die() { echo "REFUSING: $*"; exit 1; }
FAIL=0
bad() { echo "  FAIL: $*"; FAIL=1; }
ok()  { echo "  ok:   $*"; }

VERIFY_ONLY=0
if [ "${1:-}" = "--verify-only" ]; then VERIFY_ONLY=1; shift; fi
BUNDLE="${1:?Usage: restore-manifest.sh [--verify-only] <bundle-dir> [scratch-db-name]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/manifest_check.sh"
command -v pg_restore >/dev/null || die "pg_restore not found on PATH (set PG_BIN)"
command -v sha256sum >/dev/null || die "sha256sum not found"

# ---- 1. the bundle, before any database exists --------------------------------------------------------------------------------
echo "== verifying bundle $BUNDLE (no database is contacted in this step)"
verify_bundle "$BUNDLE" || die "bundle verification failed - no database was created"
MANIFEST="$BUNDLE/manifest.tsv"
ok "bundle complete: exactly 4 files, checksums match, manifest valid, marker bound to the manifest (snapshot $(mhdr "$MANIFEST" '#snapshot_id')), dump readable and its table list/database/version equal the manifest"
ok "source: database $(mhdr "$MANIFEST" '#database'), PostgreSQL $(mhdr "$MANIFEST" '#server_version'), $(mhdr "$MANIFEST" '#table_count') tables, snapshot taken $(mhdr "$MANIFEST" '#txn_start_utc')"
if [ "$VERIFY_ONLY" = 1 ]; then echo; echo "BUNDLE VERIFIED (verify-only): no database was contacted."; exit 0; fi

# ---- 2. configuration + proof that every connection is the intended LOCAL instance ---------------------------------------------
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL must point at the local server (a role allowed to CREATE DATABASE)}"
: "${OWNER_DATABASE_URL:?OWNER_DATABASE_URL (the owner role) is needed to restore + re-secure}"
: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL (the trivo_backup role: credential template for the scratch database) is required}"
: "${RUNTIME_DATABASE_URL_TEMPLATE:?RUNTIME_DATABASE_URL_TEMPLATE (trivo_runtime, with __DB__) is required to prove tenant isolation}"
: "${RESTORE_EXPECT_PORT:?RESTORE_EXPECT_PORT (port of the intended local instance) is required}"
: "${RESTORE_EXPECT_SYSTEM_IDENTIFIER:?RESTORE_EXPECT_SYSTEM_IDENTIFIER (system_identifier of the intended local instance) is required}"
[[ "$RESTORE_EXPECT_PORT" =~ ^[0-9]+$ ]] || die "RESTORE_EXPECT_PORT is not a number"
OWNER_ROLE="${OWNER_ROLE:-trivo_owner}"; [[ "$OWNER_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || die "OWNER_ROLE is not a plain identifier"

check_local_url() { # check_local_url URL LABEL : loopback host, the expected port, no host/port/service overrides in the query
  local u="$1" label="$2"
  [[ "$u" =~ ^postgres(ql)?://([^@/]*@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:([0-9]+))?(/[^?]*)?(\?.*)?$ ]] || die "$label is not a recognisable postgresql:// URL"
  local host="${BASH_REMATCH[3]}" port="${BASH_REMATCH[5]:-5432}" query="${BASH_REMATCH[7]:-}"
  case "$host" in localhost|127.0.0.1|'[::1]') ;; *) die "$label points at host '$host', not the local machine";; esac
  [ "$port" = "$RESTORE_EXPECT_PORT" ] || die "$label uses port $port, expected $RESTORE_EXPECT_PORT"
  if [[ "$query" =~ (^\?|\&)(host|hostaddr|port|service|dbname|user)= ]]; then die "$label overrides host/port/service in its query string"; fi
}
ADMIN="$(strip_prisma "$ADMIN_DATABASE_URL")"
check_local_url "$ADMIN" ADMIN_DATABASE_URL
check_local_url "$(strip_prisma "$OWNER_DATABASE_URL")" OWNER_DATABASE_URL
check_local_url "$(strip_prisma "$SOURCE_DATABASE_URL")" SOURCE_DATABASE_URL
check_local_url "$(strip_prisma "${RUNTIME_DATABASE_URL_TEMPLATE//__DB__/placeholder}")" RUNTIME_DATABASE_URL_TEMPLATE

SYSID="$(psql "$ADMIN" -Atq -c "select system_identifier from pg_control_system()")" || die "cannot read the instance identity through ADMIN_DATABASE_URL"
[ "$SYSID" = "$RESTORE_EXPECT_SYSTEM_IDENTIFIER" ] || die "the instance behind ADMIN_DATABASE_URL has a different system_identifier than expected - not the intended local instance"
ok "admin connection is the intended local instance (port $RESTORE_EXPECT_PORT, system_identifier matches), server $(psql "$ADMIN" -Atq -c 'show server_version')"

SCRATCH="${2:-trivo_prodverify_$(date -u +%Y%m%dt%H%M%Sz | tr 'A-Z' 'a-z')}"
[[ "$SCRATCH" =~ ^trivo_[a-z0-9_]*(verify|restore|scratch|test)[a-z0-9_]*$ ]] && [ "${#SCRATCH}" -le 63 ] || die "scratch database name '$SCRATCH' must match trivo_*(verify|restore|scratch|test)* (never a live database name)"
[ "$(psql "$ADMIN" -Atq -c "select count(*) from pg_database where datname='$SCRATCH'")" = 0 ] || die "database $SCRATCH already exists (this script never overwrites or drops a database)"

OWNER_SCRATCH="$(swap_db "$(strip_prisma "$OWNER_DATABASE_URL")" "$SCRATCH")"
VERIFY="$(swap_db "$(strip_prisma "$SOURCE_DATABASE_URL")" "$SCRATCH")"
RT="$(strip_prisma "${RUNTIME_DATABASE_URL_TEMPLATE//__DB__/$SCRATCH}")"
DB_SECURE_SQL="${DB_SECURE_SQL:-$HERE/../../server/prisma/db-secure.sql}"
[ -f "$DB_SECURE_SQL" ] || die "db-secure.sql not found at $DB_SECURE_SQL"
q() { psql "$VERIFY" -Atq -c "$1"; }

CREATED=0
on_exit() { local rc=$?; if [ "$rc" != 0 ] && [ "$CREATED" = 1 ]; then echo; echo "FAILED (exit $rc): scratch database $SCRATCH was KEPT for investigation (this script never drops databases)"; fi; }
trap on_exit EXIT

# ---- 3. create the scratch database and prove every connection reaches THAT database on THAT instance -------------------------
TOKEN="trivo-restore-token-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
echo "== creating scratch database $SCRATCH (owner $OWNER_ROLE)"
psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$SCRATCH\" OWNER $OWNER_ROLE ENCODING 'UTF8' TEMPLATE template0"
CREATED=1
psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "COMMENT ON DATABASE \"$SCRATCH\" IS '$TOKEN'"
psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "GRANT CONNECT ON DATABASE \"$SCRATCH\" TO trivo_backup" >/dev/null
check_token() { local got; got="$(psql "$1" -Atq -c "select shobj_description(d.oid,'pg_database') from pg_database d where d.datname=current_database()")" || die "cannot connect ($2)"; [ "$got" = "$TOKEN" ] || die "$2 does not reach the scratch database just created on the intended instance"; }
check_token "$OWNER_SCRATCH" "owner connection"; check_token "$VERIFY" "verification (backup role) connection"; check_token "$RT" "runtime connection"
ok "owner, verification and runtime connections all reach the scratch database created on the intended instance"

# ---- 4. restore ----------------------------------------------------------------------------------------------------------------
echo "== restoring $BUNDLE/trivo_snap.dump with $(pg_restore --version)"
# Run as the owner: objects become owned by it. Grants are NOT taken from the dump (--no-privileges); db-secure.sql re-establishes
# them below. SERIAL and --exit-on-error, both deliberate: tables are FORCE-RLS, and FK validation queries are themselves filtered
# by RLS. In a serial restore pg_dump's ordering enables RLS only after data + foreign keys are in place; a parallel restore does
# not guarantee that. A restore that "ignored some errors" is NOT a restore.
# (cd + relative name: a native Windows pg_restore cannot open an MSYS-style /c/... path)
( cd "$BUNDLE" && pg_restore -d "$OWNER_SCRATCH" --no-owner --no-privileges --exit-on-error -j 1 trivo_snap.dump )
echo "== re-applying db-secure.sql (grants + FORCE RLS), sha256 $(sha256sum "$DB_SECURE_SQL" | cut -c1-16)…"
psql "$OWNER_SCRATCH" -v ON_ERROR_STOP=1 -q -f - < "$DB_SECURE_SQL"

# ---- 5. verification (reads as the BACKUP role: under FORCE ROW LEVEL SECURITY an owner session with no tenant correctly sees 0 rows)
echo "== verification"
# 5.1 row counts vs the snapshot manifest (strict: same table set, same count in every table). No live-source fallback exists.
compare_manifest "$MANIFEST" "$VERIFY" || FAIL=1
# 5.2 RLS + policies + composite FKs: must reproduce the SOURCE snapshot's catalog numbers exactly
eq() { # eq LABEL RESTORED EXPECTED
  if [ "$2" = "$3" ]; then ok "$1: $2 (identical to the source snapshot)"; else bad "$1: restored=$2 but the source snapshot had $3"; fi
}
eq "tenant_isolation policies" "$(q "select count(*) from pg_policies where schemaname='public' and policyname='tenant_isolation'")" "$(mhdr "$MANIFEST" '#tenant_isolation_policies')"
eq "tables with RLS enabled AND forced" "$(q "select count(*) from pg_class k join pg_namespace n on n.oid=k.relnamespace and n.nspname='public' where k.relkind='r' and k.relrowsecurity and k.relforcerowsecurity")" "$(mhdr "$MANIFEST" '#forced_rls_tables')"
eq "composite (id, companyId) foreign keys" "$(q "select count(*) from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) and a.attname='companyId' where c.contype='f' and array_length(c.conkey,1)=2")" "$(mhdr "$MANIFEST" '#composite_company_fks')"
NORLS="$(q "select count(*) from pg_class k join pg_namespace n on n.oid=k.relnamespace and n.nspname='public' where k.relkind='r' and exists (select 1 from pg_policy p where p.polrelid=k.oid) and not (k.relrowsecurity and k.relforcerowsecurity)")"
[ "$NORLS" = 0 ] && ok "every policy-protected table has RLS enabled AND forced" || bad "$NORLS tables lost RLS/FORCE"
# 5.3 accounting + reference integrity
UNBAL="$(q "select count(*) from (select e.id from journal_entries e join journal_lines l on l.\"entryId\"=e.id group by e.id having abs(sum(l.debit)-sum(l.credit))>0.01) x")"
[ "$UNBAL" = 0 ] && ok "every journal entry balances" || bad "$UNBAL unbalanced journal entries"
XOUT="$(command psql "$VERIFY" -Atq -v ON_ERROR_STOP=1 2>&1 <<'SQL' | tr -d '\r'
DO $$
DECLARE r record; n bigint; checked int := 0; viol bigint := 0;
BEGIN
  FOR r IN
    SELECT c.conname, ct.relname AS child, pt.relname AS parent, ca.attname AS ccol, pa.attname AS pcol
      FROM pg_constraint c
      JOIN pg_class ct ON ct.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = ct.relnamespace AND cn.nspname = 'public'
      JOIN pg_class pt ON pt.oid = c.confrelid
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid  AND ca.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.conrelid  AND x.attname = 'companyId' AND NOT x.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.confrelid AND x.attname = 'companyId' AND NOT x.attisdropped)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I c JOIN public.%I p ON p.%I = c.%I WHERE c."companyId" <> p."companyId"', r.child, r.parent, r.pcol, r.ccol) INTO n;
    checked := checked + 1; viol := viol + n;
    IF n > 0 THEN RAISE NOTICE 'VIOLATION % -> % (%): % rows', r.child, r.parent, r.conname, n; END IF;
  END LOOP;
  RAISE NOTICE 'XREF_RESULT checked=% violations=%', checked, viol;
END $$;
SQL
)" || { bad "cross-company reference scan failed to run"; XOUT=""; }
XRES="$(echo "$XOUT" | grep -o 'XREF_RESULT checked=[0-9]* violations=[0-9]*' || true)"
XCHK="${XRES#*checked=}"; XCHK="${XCHK%% *}"; XVIO="${XRES##*violations=}"
if [ -z "$XRES" ]; then bad "cross-company reference scan produced no result"
elif [ "$XVIO" != 0 ]; then bad "cross-company references: $XVIO violating rows ($(echo "$XOUT" | grep VIOLATION | tr '\n' ';'))"
elif [ "${XCHK:-0}" -lt 20 ]; then bad "cross-company scan covered only $XCHK foreign keys (expected the full set)"
else ok "no plain foreign key anywhere points at another company's row ($XCHK company-scoped foreign keys scanned)"; fi
# 5.4 isolation survives: the REAL runtime role, EVERY table carrying a companyId column (whether or not RLS is still on: a table that lost it must FAIL here), no context / unknown company / each real company
TABLES="$(q "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public' join pg_attribute a on a.attrelid=c.oid and a.attname='companyId' and not a.attisdropped where c.relkind='r' order by 1")"
COMPANIES="$(q "select id from companies order by \"createdAt\"")"
[ -n "$COMPANIES" ] || bad "the restored database has no companies"
NCO=$(echo "$COMPANIES" | grep -c . || true)
UNKNOWN_CO="trivo-no-such-company"
checked=0; skipped=""; vacuous=0; tbad=0
for t in $TABLES; do
  declare -A own=(); while IFS='|' read -r cid cnt; do [ -n "$cid" ] && own["$cid"]="$cnt"; done < <(q "select \"companyId\"||'|'||count(*) from \"$t\" group by \"companyId\"")
  total="$(q "select count(*) from \"$t\"")"
  script="begin;
select 'NOCTX|'||count(*) from \"$t\";
select set_config('app.tenant_company_id','$UNKNOWN_CO',true) is null;
select 'UNKNOWN|'||count(*) from \"$t\";"
  for cid in $COMPANIES; do script="$script
select set_config('app.tenant_company_id','$cid',true) is null;
select 'CO|$cid|'||count(*)||'|'||count(*) filter (where \"companyId\"='$cid') from \"$t\";"; done
  script="$script
rollback;"
  out="$(printf '%s\n' "$script" | command psql "$RT" -Atq 2>&1 | tr -d '\r' || true)"
  if echo "$out" | grep -qi 'permission denied'; then skipped="$skipped $t"; continue; fi
  checked=$((checked+1)); [ "$total" -gt 0 ] || vacuous=$((vacuous+1))
  [ "$(echo "$out" | grep '^NOCTX|' | cut -d'|' -f2)" = 0 ] || { bad "runtime role with NO company context saw rows in $t"; tbad=1; }
  [ "$(echo "$out" | grep '^UNKNOWN|' | cut -d'|' -f2)" = 0 ] || { bad "runtime role in an UNKNOWN company context saw rows in $t"; tbad=1; }
  for cid in $COMPANIES; do
    line="$(echo "$out" | grep "^CO|$cid|" || true)"; seen="$(echo "$line" | cut -d'|' -f3)"; mine="$(echo "$line" | cut -d'|' -f4)"; want="${own[$cid]:-0}"
    if [ -z "$line" ] || [ "$seen" != "$mine" ] || [ "$mine" != "$want" ]; then bad "company ${cid:0:8}… in $t: runtime role saw '${seen:-?}' rows, ${mine:-?} of them its own, expected $want/$want"; tbad=1; fi
  done
  unset own
done
if [ "$checked" -lt 20 ]; then bad "only $checked company-scoped tables could be tested through the runtime role (expected the full set)"
elif [ "$tbad" = 0 ]; then ok "runtime role: no rows with no context or an unknown company, and exactly each company's own rows in each of $NCO company context(s), on all $checked company-scoped RLS tables ($vacuous empty, so tested only for 'sees nothing')"; fi
[ -z "$skipped" ] || echo "  note: no runtime grant (not tested through the runtime role):$skipped"
[ "$((checked - vacuous))" -ge 5 ] || bad "only $((checked - vacuous)) company-scoped tables hold rows, so the isolation proof is mostly vacuous"

echo
if [ "$FAIL" = 0 ]; then echo "RESTORE VERIFIED into $SCRATCH (kept; nothing was dropped). When finished, YOU may drop it:  psql \"\$ADMIN_DATABASE_URL\" -c 'DROP DATABASE \"$SCRATCH\"'"; else echo "RESTORE VERIFICATION FAILED (scratch DB $SCRATCH kept for inspection)"; exit 1; fi
```
### local_restore_env.sh
```
# Operator convenience, SOURCED (never executed): builds the environment restore-manifest.sh needs for the LOCAL staging cluster
# (PostgreSQL 18, localhost:54329, the real trivo_owner / trivo_backup / trivo_runtime role split). Credentials are read from files on
# this machine and exported into the current shell only - nothing is printed. Usage:   . ./local_restore_env.sh
export PG_BIN="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"
export PATH="$PG_BIN:$PATH"
export MSYS_NO_PATHCONV=1 PGSSLMODE=require
_H=localhost; _P=54329; _S="?sslmode=require"
_SUPER="$(tr -d '\r\n' < /c/trivo-staging/superpw.txt)"
_OWNER="$(grep '^OWNER_DATABASE_URL' /c/trivo-staging/rlstest.env | sed -E 's#.*://trivo_owner:([^@]+)@.*#\1#')"
_RUN="$(grep '^DATABASE_URL' /c/trivo-staging/rlstest.env | sed -E 's#.*://trivo_runtime:([^@]+)@.*#\1#')"
_BK="$(tr -d '\r\n' < /c/trivo-staging/backup-pw.txt)"
export ADMIN_DATABASE_URL="postgresql://postgres:${_SUPER}@${_H}:${_P}/postgres${_S}"
export OWNER_DATABASE_URL="postgresql://trivo_owner:${_OWNER}@${_H}:${_P}/postgres${_S}"
export SOURCE_DATABASE_URL="postgresql://trivo_backup:${_BK}@${_H}:${_P}/postgres${_S}"        # credential template only; its db name is swapped
export RUNTIME_DATABASE_URL_TEMPLATE="postgresql://trivo_runtime:${_RUN}@${_H}:${_P}/__DB__${_S}"
export OWNER_ROLE=trivo_owner RESTORE_EXPECT_PORT="$_P"
export RESTORE_EXPECT_SYSTEM_IDENTIFIER="$(command psql "$ADMIN_DATABASE_URL" -Atq -c 'select system_identifier from pg_control_system()' | tr -d '\r')"
unset _SUPER _OWNER _RUN _BK
echo "local restore environment ready: instance port $RESTORE_EXPECT_PORT, system_identifier set ($(command psql "$ADMIN_DATABASE_URL" -Atq -c 'show server_version' | tr -d '\r'))"
```

## Runbook
# TRIVO — production backup restore verification: runbook

**Status: PREPARED, NOT EXECUTED.** Nothing here has been run against production. Every step below that touches
production waits for explicit approval.

## What this does

1. On the production host, takes ONE PostgreSQL snapshot of `trivo_prod` (as the read-only `trivo_backup` role) and, from that
   same snapshot, writes a per-table row-count manifest and a `pg_dump` (client + server both PostgreSQL 16).
2. Publishes the result as ONE directory `bundle-<utc>-<random>` under `/var/backups/trivo-prod-verify/` by a single atomic
   `rename(2)`. Nothing exists under a `bundle-*` name until all four files are written and verified.
3. A bundle is exactly four files, directory mode 700, files mode 600, owner root:

   | file | meaning |
   |---|---|
   | `trivo_snap.dump` | `pg_dump -Fc` of the whole database, taken with `--snapshot=<exported snapshot>` |
   | `manifest.tsv` | counts only (no row data): database, server version, snapshot id, table list with exact row counts, RLS/FK catalog counts |
   | `SNAPSHOT_OK` | the **success marker**: ties the dump to the manifest (same snapshot id, database, version, table count, both SHA-256s) |
   | `SHA256SUMS` | SHA-256 of the three files above |

4. On this machine, `restore-manifest.sh` verifies the bundle with no database at all, then restores into a NEW scratch
   database on the local PostgreSQL 18 instance and verifies row counts, RLS, composite FKs, journal balance, cross-company
   integrity and tenant isolation through the real `trivo_runtime` role. `server/scripts/restore.sh` is not touched.

## Blockers / assumptions that could not be confirmed offline (must be checked by the first read-only pre-flight)

| # | assumption | how it is checked | if false |
|---|---|---|---|
| 1 | `/opt/trivo-prod/.env` has exactly one `BACKUP_PW=` line (plain or quoted value) | pre-flight (count only, value never printed) + `host_run.sh` | refuses |
| 2 | Docker network `trivoprod_default`, DB host `postgres:5432`, image `postgres:16-alpine` present locally (all taken from `ops/live/backup-prod.sh`, which uses them nightly) | pre-flight + `host_run.sh` (`--pull never`) | refuses |
| 3 | `trivo_backup` really is read-only, BYPASSRLS, not superuser, can SELECT every table and sequence in `public` (as `production-rls-roles.sql` / `db-secure.sql` define) | SQL guards inside the snapshot transaction | refuses, nothing written |
| 4 | Production server is PostgreSQL 16 | SQL guard `server_major_version_is_expected` + client-tool major check | refuses |
| 5 | The host has ≥ 2× database size + 100 MB free under `/var/backups` | `run.sh` preflight | refuses |
| 6 | Local disk holding `C:\trivo-staging\prod-restore-test\` is encrypted (BitLocker) | **cannot be checked from here** — see "Local handling" | the bundle is the full customer database in the clear; do not proceed until you accept that or enable BitLocker |
| 7 | SSH route `ssh trivo-e2e` (root@151.185.58.77, key in `~/.ssh`) works and the host key is already in `known_hosts` (it is) | first ssh command | stop |

## Production sequence (all `ssh`/`scp` use the existing approved alias `trivo-e2e`; `StrictHostKeyChecking=yes` so an unknown host key aborts)

Run from Git Bash on this machine in `P:\ERP\ops\backup-verify`. Hashes below are the reviewed ones; **compare them with the report
before pasting.**

```bash
cd /p/ERP/ops/backup-verify
H_RUN=1ee41cdc88250fb0f1fdba6db2a9313e225bfe99176fa0e952fa5def069fc436
H_SQL=71eba5c3d6e2fcdc4f4c5a3c4d5950c900c1fe8cedeffb52423170b82da0aadc
H_POST=da58c83a44780fe639e0f0f574a8b10ae25637d15fdabd17dd19b43475795b14
H_HOST=8f96222c0b4e08e13ea609f06b17732b648ba1bc378cf004426ed6b17a5d9430
# 0. LOCAL, no production contact: the files on this machine are the reviewed ones
printf '%s  run.sh\n%s  snapshot_dump.sql\n%s  bundle_postcheck.sh\n%s  host_run.sh\n' $H_RUN $H_SQL $H_POST $H_HOST | sha256sum -c -
SSH="ssh -o StrictHostKeyChecking=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=8 trivo-e2e"
SCP="scp -o StrictHostKeyChecking=yes"
```

**Step 1 — read-only pre-flight on the host (changes nothing).** Pick a time outside 01:45–03:30 IST (nightly backup is 02:15 IST).

```bash
$SSH 'date -u; TZ=Asia/Kolkata date; systemctl is-active trivoprod-backup.service; systemctl list-timers trivoprod-backup.timer --no-pager;
      docker image inspect postgres:16-alpine --format "image {{.Id}}"; docker network inspect trivoprod_default --format "network {{.Name}}";
      docker ps --format "{{.Names}} {{.Image}} {{.Status}}" | grep trivoprod; echo "BACKUP_PW lines: $(grep -c "^BACKUP_PW=" /opt/trivo-prod/.env)";
      df -h /var/backups; ls -ld /var/backups/trivo-prod-verify 2>&1 | head -1'
```
Expected: service `inactive`, image/network found, `BACKUP_PW lines: 1`, free space ample, and `ls` says *No such file or directory*.

**Step 2 — create ONLY the dedicated output directory (700, root) and its `scripts` subdirectory.**

```bash
$SSH 'set -e; test ! -e /var/backups/trivo-prod-verify; install -d -m 700 -o root -g root /var/backups/trivo-prod-verify /var/backups/trivo-prod-verify/scripts; ls -ld /var/backups/trivo-prod-verify'
```

**Step 3 — upload the reviewed scripts.**

```bash
$SCP run.sh snapshot_dump.sql bundle_postcheck.sh host_run.sh trivo-e2e:/var/backups/trivo-prod-verify/scripts/
```

**Step 4 — verify their full SHA-256 ON THE HOST before anything runs** (hashes are typed from this console, not read from an uploaded file).

```bash
$SSH "cd /var/backups/trivo-prod-verify/scripts && printf '%s  run.sh\n%s  snapshot_dump.sql\n%s  bundle_postcheck.sh\n%s  host_run.sh\n' $H_RUN $H_SQL $H_POST $H_HOST | sha256sum -c - && chmod 600 run.sh snapshot_dump.sql && chmod 700 bundle_postcheck.sh host_run.sh && ls -l"
```
All four must say `OK`. Anything else: stop; do not run.

**Step 5 — run (the approved PostgreSQL 16 container; only the DB connection + the output directory are reachable).**

```bash
$SSH "timeout 1800 bash /var/backups/trivo-prod-verify/scripts/host_run.sh $H_RUN $H_SQL $H_POST"
```
`host_run.sh` itself: re-checks the three script hashes, refuses near the nightly window or while a backup runs, refuses a non-700
directory, reads `BACKUP_PW` without printing it (passed to the container by variable *name*, never on a command line), runs
`docker run --rm --pull never --network trivoprod_default --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp
--memory 1g -v …/scripts:/scripts:ro -v /var/backups/trivo-prod-verify:/out postgres:16-alpine sh /scripts/run.sh`, and afterwards runs
`bundle_postcheck.sh` (modes 700/600 root, exactly four regular files, SHA-256s, marker, manifest, marker↔file hashes).
Expected last lines: `POSTCHECK OK …`, `VERIFIED_BUNDLE /var/backups/trivo-prod-verify/bundle-…`, the three `SHA256SUMS` lines.

**Step 6 — independent look at the finished bundle (read-only), and note its name.**

```bash
BUNDLE=$($SSH 'ls -1dt /var/backups/trivo-prod-verify/bundle-* | head -1' | xargs basename); echo "$BUNDLE"
$SSH "bash /var/backups/trivo-prod-verify/scripts/bundle_postcheck.sh /var/backups/trivo-prod-verify/$BUNDLE trivo_prod; ls -l /var/backups/trivo-prod-verify/$BUNDLE; cat /var/backups/trivo-prod-verify/$BUNDLE/SNAPSHOT_OK; cat /var/backups/trivo-prod-verify/$BUNDLE/SHA256SUMS; sha256sum /var/backups/trivo-prod-verify/$BUNDLE/SHA256SUMS"
```

**Step 7 — transfer (SSH/SCP only; binary-safe; never through any web service).**

```bash
mkdir -p /c/trivo-staging/prod-restore-test
# restrict the local folder to this Windows user only (customer data):
powershell -NoProfile -Command 'icacls C:\trivo-staging\prod-restore-test /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"'
$SCP -r trivo-e2e:/var/backups/trivo-prod-verify/$BUNDLE /c/trivo-staging/prod-restore-test/
```
(PowerShell equivalent of the copy: `scp -o StrictHostKeyChecking=yes -r trivo-e2e:/var/backups/trivo-prod-verify/<BUNDLE> C:\trivo-staging\prod-restore-test\`)

**Step 8 — verify the transferred bundle locally, still with no database.**

```bash
cd /c/trivo-staging/prod-restore-test/$BUNDLE && sha256sum -c SHA256SUMS && sha256sum SHA256SUMS      # the last hash must equal the one printed in step 6
cd /p/ERP/ops/backup-verify && PG_BIN="/c/Program Files/PostgreSQL/18/bin" bash restore-manifest.sh --verify-only /c/trivo-staging/prod-restore-test/$BUNDLE
```

**Step 9 — restore + verify into a NEW scratch database on the local PostgreSQL 18 instance** (takes ~5 minutes for a database of this size).

```bash
cd /p/ERP/ops/backup-verify
. ./local_restore_env.sh            # builds the connection settings from files on this machine; prints nothing secret
bash restore-manifest.sh /c/trivo-staging/prod-restore-test/$BUNDLE trivo_prodverify_$(date -u +%Y%m%d)
```
Success ends with `RESTORE VERIFIED into trivo_prodverify_…` and exit code 0. Failure ends with `RESTORE VERIFICATION FAILED` / `FAILED (exit N): scratch database … was KEPT` and a non-zero exit code. **Nothing is ever dropped by these scripts.**

## Failure recovery and evidence preservation

The production side is read-only against the database, so there is never anything to roll back in PostgreSQL. State is only files:

| what you see | meaning | what to do |
|---|---|---|
| `host_run.sh` printed `REFUSING: …` | a pre-check failed before any container ran | nothing was created; fix the cause, re-run |
| container exit ≠ 0, no `bundle-*`, no `.tmp-*` | an ordinary failure; the run removed only its OWN staging directory | read the printed reason (and `run-*.log`), fix, re-run |
| a `.tmp-<id>` directory exists (run killed: SIGKILL, host reboot, OOM, connection drop) | **interrupted run.** It may hold a partial dump of customer data. New runs REFUSE to start while it exists; nothing is deleted automatically | `ls -la /var/backups/trivo-prod-verify/.tmp-*`; `docker ps` (no container still running?); then either keep it as evidence, or abandon it deliberately: `rm -rf /var/backups/trivo-prod-verify/.tmp-<id>`. There is **no resume**: a snapshot cannot be resumed; the next run is a new snapshot. |
| a `bundle-*` directory exists but `host_run.sh`/post-check reported a failure | published but **UNVERIFIED** | do not transfer it; keep it; investigate; a new run creates a new bundle beside it |
| any `bundle-*` that passed post-check | complete and final | never modified or deleted by these scripts; every re-run makes a different bundle |

* Existing bundles, `.tmp-*` directories, the `scripts/` copy, `run-*.log` and the nightly `/var/backups/trivo-prod` are never touched.
* Removing the bundle from the production host after a successful transfer is a deliberate manual decision (it is a full copy of customer data on the host):
  `rm -rf /var/backups/trivo-prod-verify/<bundle>` — only after you confirm the local copy verified.
* A killed run can leave a database session of `trivo_backup` that only ends when the server notices the dead connection (seconds); the role is limited to 3 connections and a run needs 2, so the next run waits up to 20 s for other sessions of the role to disappear and then refuses.
* Local: a failed restore keeps its scratch database (`trivo_prodverify_*`) for investigation. Drop it yourself when finished:
  `psql "$ADMIN_DATABASE_URL" -c 'DROP DATABASE "trivo_prodverify_…"'`.

## Local handling of the bundle

The bundle is the **entire production database, all companies, including password hashes**. Keep it only in the access-restricted folder from step 7,
confirm disk encryption (blocker 6: `manage-bde -status C:` in an elevated shell), do not copy it to any cloud/chat/ticket/web service, and delete the local copy when the verification is signed off.

## Test suite (all local, disposable)

`tests/t1_production_side.sh` (docker, PG16 test server), `t2_bundle_and_manifest.sh`, `t3_restore.sh` (local PG18), `t4_postcheck_linux.sh`
(real Linux perms via WSL2, root), `t5_host_run.sh`. See the report for the last results. `tests/env.sh` documents the two test clusters.

---
## FINAL VERIFICATION RUN (2026-10-12 19:20Z – 19:44Z) — CURRENT RESULTS
**Everything above this heading (including the SHA-256 table at the top and every earlier "RESULT" line) is STALE history from earlier runs; only this section reflects the final files.**
Production was NOT contacted. No SSH, pre-flight, upload, bundle creation or production data transfer. No logs or scratch databases were removed.
Final `manifest_check.sh` SHA-256 (supersedes the value in the top table): `2bc25351804b360288d629a359650651d640ce6e95b97261eb859ee981c786d9`
Test bundle: the T1-built bundle `bundle-20261012T174245Z-6b652d37` (local PG16 test data). Logs: `/c/Users/VGD/AppData/Local/Temp/claude/p--ERP/2069a63b-5448-4337-9f6d-15b7c98295e8/scratchpad/final4/`.

| Test | Run tag / log | Started (UTC) | Exit | Result |
|---|---|---|---|---|
| T3 restore (fixed manifest_check.sh) | tag `final4`, `t3.log` | 19:20:35 | 0 (ended 19:40:21) | RESULT pass=42 fail=0 |
| T4 post-check on Linux (WSL2 root) | `t4.log` | 19:43:45 | 0 | RESULT pass=27 fail=0 |
| T5 host run | `t5.log` | 19:40:35 | 0 | RESULT pass=31 fail=0 |
| T6 hardening, no DB | `t6.log` | 19:41:35 | 0 | RESULT pass=84 fail=0 |
| T7 preflight (local, read-only) | `t7.log` | 19:42:52 | 0 | RESULT pass=16 fail=0 |

T1 and T2 were not rerun (no change affects them); their earlier results above remain as recorded, not re-verified against the final files.

**Harness note (honest record):** my first T4 attempt (19:40:30, exit 1) was invoked without its required 2nd argument (the `pg_restore -l` listing) and produced no result. A second attempt (19:43:19, exit 1, pass=23 fail=4: P0, P12, P19, P25) used an EMPTY listing because I ran the Windows `pg_restore` on a `/c/...` path it cannot open. Neither was a defect in the scripts; the third attempt, with the listing generated from inside the bundle directory (1680 lines), is the authoritative T4 result above. The two bad attempts were overwritten in `t4.log` (only `rest.status` keeps their timestamps).
