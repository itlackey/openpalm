# Release Architecture

## Product Release

`.github/workflows/release.yml` is the product release authority. It prepares
one candidate commit, tests that candidate, builds images and native assets from
the candidate-local source tree, and validates one complete asset manifest.

Product user assets are published once on the summary GitHub Release named by
the bare product version. The release contains the six CLI binaries, Electron
artifacts, `openpalm-host-assets-<version>.tar.gz`,
`release-assets-manifest.json`, and `checksums-sha256.txt`. There are no
per-unit GitHub Releases and no deploy bundle.

The `openpalm` npm package is only a convenience bootstrap. It is published
after the GitHub Release exists and its binary and checksum assets have been
verified through public URLs. CLI binaries never depend on npm publication.
`@openpalm/ui`, `@openpalm/skeleton`, and `@openpalm/lib` are not published by
the product workflow; historical versions remain untouched.

Images use the canonical Dockerfiles and the restored candidate-local source.
They do not depend on npm jobs. The 0.13 workflow publishes immutable version
tags only and deliberately does not promote a mutable `latest` alias.

The source branch and product tag are pushed atomically and as late as practical. Live runs
are accepted only from `main` or `release/*`; dry runs perform the same build,
pack, manifest, checksum, and validation work without registry mutation.

## Extensions

`.github/workflows/publish-extensions.yml` is an independent workflow for
`@openpalm/guardian`, `@openpalm/portal-sdk`, `@openpalm/discord-portal`, and
`@openpalm/slack-portal`. It has its own concurrency group and is not a
dependency of product release or product image jobs.

Setup scripts are version-neutral. Without an explicit version they resolve
the public latest GitHub Release; the product workflow never stamps them.
