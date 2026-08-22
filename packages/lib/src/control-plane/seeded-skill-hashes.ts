/**
 * Every file this repo's history shows OpenPalm seeding into
 * `knowledge/skills/`, keyed by the path relative to that directory and valued
 * by the sha256 of each content it was shipped with.
 *
 * This is a CLOSED historical record, not a live manifest. The release-shipped
 * skills moved to the managed `system/skills/` tree in 0.13.0 and the skeleton
 * has carried no `knowledge/skills/` since, so nothing will ever be seeded
 * there again and this table can only shrink — delete it outright once the
 * supported upgrade floor is past 0.13.0.
 *
 * It exists because `pruneDuplicateShippedSkills` cannot otherwise tell an
 * untouched copy from an operator's edits. Comparing against what THIS build
 * ships only ever matched a home seeded by this exact build: shipped skill
 * content changed between 0.12.x and 0.13.0, so on every upgraded home no name
 * matched, all three were kept, and the stale stash copies shadowed the very
 * skills the move existed to give an update channel. The bug only spared fresh
 * installs. Matching the seeded copy against any content OpenPalm is KNOWN to
 * have shipped at that path recovers the answer without guessing.
 *
 * Per FILE rather than per tree, because a seeded tree is legitimately a
 * mixture of releases: the seed skipped files that already existed but still
 * added new ones, so a home can hold `SKILL.md` from its first install beside a
 * `tools.json` added three releases later.
 *
 * BOTH historical locations count. The skeleton lived at
 * `.openpalm/knowledge/skills/` until it moved under `packages/skeleton/` in
 * 2026-06, and a home installed before that move holds the content shipped from
 * the OLD path — nine distinct (path, content) pairs that exist nowhere in the
 * new one, four of them `config-diagnostics/SKILL.md` as shipped at
 * v0.11.0-beta.12 through v0.11.0-beta.15. Scanning only the current path
 * silently reproduces a table missing all nine.
 *
 * Regenerate/verify from a full checkout (order-independent, one line per
 * distinct content):
 *
 *   for p in packages/skeleton/knowledge/skills .openpalm/knowledge/skills; do
 *     for c in $(git rev-list --all -- "$p"); do git ls-tree -r "$c" "$p"; done
 *   done | awk '{sub(/^.*knowledge\/skills\//,"",$4); print $3"\t"$4}' | sort -u |
 *   while IFS=$'\t' read -r blob path; do
 *     echo "$path $(git cat-file blob "$blob" | sha256sum | cut -d' ' -f1)"
 *   done | LC_ALL=C sort -u
 *
 * A miss is safe by construction: an unrecognised file is treated as the
 * operator's and the copy is kept. So content shipped from a branch that no
 * longer exists costs an operator a warning, never a deletion. So this table is
 * as complete as reachable history makes it, which is not the same as provably
 * complete — the sweep's log line says "unrecognised", not "edited", for that
 * reason.
 */
export const SEEDED_SKILL_FILE_HASHES: Readonly<Record<string, readonly string[]>> = {
  'config-diagnostics/SKILL.md': [
    '11768e0d1b8c3ccc8d04072623a28f9ea047bb8174c793498ee3230c202cc778',
    '6766ed53c0a420b4e3747ca4cf3c4440d92b6115b833fc12fc2274a52dd343f6',
    '6e4947ba963eae0e50a500870940c8af7843576f32c876d0cba11a57dc0ae82e',
    '83270c038cbe8d7ca74ce796e594a77e33c7e9d79958b48ddce063a2d5713ea5',
    '87f3fd27316a944d6d6ffdb8537e2247ab4813208f59f8c984165a008673ba36',
    '9364c8839a4b2dcbad37ca34bf8c5c08d83cf4c70fd09b11bbd4abc1f41589c2',
    'd68d6fad94623f9c1f500d36a625d5207dd97ce1522193ecc989d3a6be80f337',
    'e1be5ba7dab6314c88ad2ad569cca7c663bf4971ea7631c3b309b7eb4f33add1',
    'f9f0a6cd0a3ff7ebb002d89297ddc2eed7d875f56455163d79aa57b4ff9458a2',
  ],
  'gws-setup/SKILL.md': [
    '0db4c61c4294b2f83e0f63c15647ceef45125008ed70995b159c9b7ddbcd3417',
    '275f866415fa242f403c1a85c2153f7f7f1fb8add67ae380e74ad5a2e0a196d8',
    '2de85675fe1fa99ba0ed1196f3fbe11e1aca7ed50aa83fe181fe1cff3842c9f1',
    '8839a9c0ee7e727d18a4cedcd0e91c9c1635542b8f316da3fcf387322e7bc008',
  ],
  'gws-setup/references/auth-methods.md': [
    '3e031ba6ff33b29fe1535805499bd4125bec9ce3158d69c18dffbea694977f08',
    '7ad40922eb7a68264a4436f3946c4b171bf2cd55aacc5631ab9f68e3decb2873',
  ],
  'gws-setup/scripts/gws-export.sh': [
    '38b6ff191bcd66a9304b35b82b6f8edc82efe23e0a10e5952e05d7e494727e51',
    'b2f24d0112c975b0b16e7c9eb39ab30f12f2ae01816ccd2b035377c9be09b766',
  ],
  'gws-setup/scripts/gws-setup.sh': [
    '21f61d562097bbd8722fc7875ca08eeb6dbc85f259ca1ed0c4058385a41ce12c',
    '727bcf5717e93bdb508cfa4b4171329709479374c759a0ff6cc8c410a20810ec',
    '8065f075db104a233124ac638c7c626ef90e5fb8d76a059690db8bb57d6cc110',
    'afccb05e704a30ddbf076faca06ae3d37f3a856898d4d65063f7d3051b03611a',
  ],
  'gws-setup/scripts/gws-verify.sh': [
    '345375531dfba3c438820864b3d0c1c298bbe847e567e327c098d6d1f40759e1',
    '9825c048ae37ed47e87c7190b4f05c810a435d4d8ccd5afd05993cdef7ca70ba',
    'b05d0be17f329685cce6300766ec00b4a82a3256399e27a8e13073519cf62d16',
  ],
  'install-optional-tool/SKILL.md': [
    '245fda680e64749e2b9e4be94cb48dcc7a644d1466f4b49320df17d630b7aca2',
    '89309df7cc6b00e3e94c97809a3e2bd837c36e7e51659bded3cde978c35ff462',
    'f6f2a070c14847073acc53b368194e7fb4fc2930b180d9c0f6fc1f196ecce026',
  ],
  'install-optional-tool/scripts/install-tool.sh': [
    'f99339580a1ed68acc053f51a3e62c889b137dc54615e58bbd9527f66ed39f89',
  ],
  'install-optional-tool/tools.json': [
    '3ef4706d01276bd35319d14492d9d6d19f2acae5b11b3d09506f207f5abe79eb',
    '8e1ada96517f9579301d9e63b5dfa62d8649191766f2b693ca12826e14284de4',
    'bcf4f4c45f912e64ff3d3255fcb45c1ef8ba43077af8ec3e2071c4eb86c58c6c',
    'da64eade20921dd8e794e7a904bfa361c5cf707d561599f07b5a2d890c7eb6cf',
  ],
  'notify/SKILL.md': [
    '85750248e83f3cd1aa4e01f9fb0ed7c9dc76df627c1e57c4943c4b78dd5db124',
    'ee45db71c16652466b032d4ec50d353945cc46459842204b541930ce6119807f',
  ],
  'notify/examples/apprise.conf': [
    '9ad5de06845c7ce150fad29b5e09e85e07cc5f6a06c93401645a5437a4c612a7',
  ],
  'notify/examples/apprise.yaml': [
    'c3881bf7dec734257e71ac5f77d2d25e503b2bd32debb4bd186e2d09f8d7498c',
  ],
  'notify/examples/usage.md': [
    'b6be4f77dd8a751a0cce3f526e917ace9345df9340bd6229c225012df06a9177',
  ],
  'notify/scripts/notify.sh': [
    '68d674be7a3d248dcbd59365f5e8aab6f13241ce813b71140c5b3703479bb183',
  ],
};
