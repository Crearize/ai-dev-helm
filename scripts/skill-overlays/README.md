# Harness skill overlays

`transform-skills.sh` copies the selected upstream superpowers skills, then
`apply-skill-overlays.js` applies the files here on top. The harness owns these
files; they carry the harness policy (proportional workflow, Design Gate with
design review before implementation, model-table references).

- `<skill>/<file>` replaces the upstream file (or adds a harness-only file).
- `<skill>/<file>.prepend` is prepended to the upstream file.
- `manifest.json` records, per file, the SHA-256 of the upstream file the
  overlay was written against (`null` when upstream has no such file).

If upstream changes a file an overlay owns, the sync fails and names the file.
Compare that file between the `upstreamVersion` in the manifest and the new
release, port what matters into the overlay, then run
`node scripts/apply-skill-overlays.js update <upstream_skills_dir> <version>`
and `npx vitest run lib/skill-transform.test.js`. The scheduled sync reports such
drift as an issue instead of failing every day.
