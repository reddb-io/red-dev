# vendor/sigstore

The public Sigstore trust root (`trusted_root.embedded` — the published `trusted_root.json`, byte for byte), vendored so red-dev can
verify a RedSkills package set's cosign bundle with no network — see
`sigstore.lock.json` for where it came from, its digest and how to refresh it.
It is embedded into the binary by `src/red-skills-set.ts` and handed to
`cosign verify-blob --trusted-root`.
