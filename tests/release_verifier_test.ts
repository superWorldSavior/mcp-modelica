import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { sha256, sha256Bytes } from "../src/domain/hashing.ts";
import {
  assertOriginatingWorkflowRun,
  coordinatePublishedReleaseVerifier,
  type FetchLike,
  GHCR_IMAGE_NAME,
  GHCR_PUBLISH_WORKFLOW_NAME,
  GHCR_PUBLISH_WORKFLOW_PATH,
  inspectTemporallyNeutralReadme,
  JSR_PACKAGE_NAME,
  JSR_PUBLISH_WORKFLOW_NAME,
  JSR_PUBLISH_WORKFLOW_PATH,
  parseCli,
  type PublicationStatus,
  publicationStatusesFromWorkflowRuns,
  PublishedReleaseVerifierError,
  renderPublishedReleaseCli,
  resolveReleaseTagCommit,
  runPublishedReleaseCli,
  verifyPublishedRelease,
  waitForPublicationPair,
} from "../scripts/verify-published-release.ts";

const VERSION = "0.6.5";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY = "Casys-AI/mcp-modelica";
const V064_RELEASE_TAG = "v0.6.4";
const V064_RELEASE_COMMIT = "dd47248068b50d8f6dbe41d5208a3e6b2f75fa49";
const V064_ANNOTATED_TAG_OBJECT = "92c656b1c521a4b1014aeaf20c1434e63ca3f1d0";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const FAKE_DIGEST = `sha256:${"b".repeat(64)}`;
const ATTESTATION_DIGEST = `sha256:${"1".repeat(64)}`;

const NEUTRAL_README = `# @casys/mcp-modelica

Run the qualified container:

\`\`\`bash
docker run --rm ghcr.io/casys-ai/mcp-modelica@\${MODELICA_IMAGE_DIGEST:?set from verified evidence}
\`\`\`

That command deploys the digest from verified evidence. After the paired GHCR image
publication has succeeded, resolve the immutable GHCR index digest for
ghcr.io/casys-ai/mcp-modelica:${VERSION} and set MODELICA_IMAGE_DIGEST from that verified
evidence. Deploy that digest rather than the mutable tag.

\`\`\`bash
deno run -A jsr:@casys/mcp-modelica@${VERSION}/server --port=3016
\`\`\`
`;

const PUBLISHED_DENO_JSON = JSON.stringify(
  {
    name: JSR_PACKAGE_NAME,
    version: VERSION,
  },
  null,
  2,
) + "\n";

Deno.test("neutral README accepts a digest variable deploy and a version tag only in the explanation", () => {
  const report = inspectTemporallyNeutralReadme(NEUTRAL_README, { version: VERSION });
  assertEquals(report, { ok: true, violations: [] });
});

Deno.test("neutral README rejects forthcoming wording", () => {
  const report = inspectTemporallyNeutralReadme(
    NEUTRAL_README.replace(
      "That command deploys the digest from verified evidence",
      "This is not the forthcoming image",
    ),
    { version: VERSION },
  );
  assertEquals(report.ok, false);
  assert(report.violations.includes("forthcoming"));
});

Deno.test("neutral README rejects a historical matching-image digest pin", () => {
  const report = inspectTemporallyNeutralReadme(
    NEUTRAL_README.replace(
      "ghcr.io/casys-ai/mcp-modelica@${MODELICA_IMAGE_DIGEST:?set from verified evidence}",
      "ghcr.io/casys-ai/mcp-modelica@sha256:26bdf32513345e23233a9db7020f45675b4f029803e2f85204fbadd261491360",
    ),
    { version: VERSION },
  );
  assertEquals(report.ok, false);
  assert(report.violations.includes("image-digest-pin"));
});

Deno.test("neutral README requires the digest variable with a ${...?} guard", () => {
  const report = inspectTemporallyNeutralReadme(
    NEUTRAL_README.replace(
      "ghcr.io/casys-ai/mcp-modelica@${MODELICA_IMAGE_DIGEST:?set from verified evidence}",
      "ghcr.io/casys-ai/mcp-modelica@${MODELICA_IMAGE_DIGEST}",
    ),
    { version: VERSION },
  );
  assertEquals(report.ok, false);
  assert(report.violations.includes("missing-digest-variable"));
});

Deno.test("neutral README fails when wrapped required guidance is removed from the checked-in file", async () => {
  const packageVersion = (JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { version: string }).version;
  const readme = await Deno.readTextFile(new URL("../README.md", import.meta.url));
  const strippedGuidance = readme
    .replace(/After the paired GHCR image\s+publication has succeeded/gi, "")
    .replace(/immutable GHCR index\s+digest/gi, "");
  assert(strippedGuidance !== readme, "the checked-in README must wrap the required guidance");
  const guidanceReport = inspectTemporallyNeutralReadme(strippedGuidance, {
    version: packageVersion,
    image: "ghcr.io/superworldsavior/mcp-modelica",
  });
  assertEquals(guidanceReport.ok, false);
  assert(guidanceReport.violations.includes("missing-post-publication-digest-guidance"));

  const strippedVariable = readme.replaceAll(
    "ghcr.io/superworldsavior/mcp-modelica@${MODELICA_IMAGE_DIGEST:?set from verified evidence}",
    "ghcr.io/superworldsavior/mcp-modelica:placeholder",
  );
  assert(strippedVariable !== readme, "the checked-in README must include the digest variable");
  const variableReport = inspectTemporallyNeutralReadme(strippedVariable, {
    version: packageVersion,
    image: "ghcr.io/superworldsavior/mcp-modelica",
  });
  assertEquals(variableReport.ok, false);
  assert(variableReport.violations.includes("missing-digest-variable"));
});

Deno.test("checked-in README is temporally neutral for the package version", async () => {
  const packageVersion = (JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { version: string }).version;
  const readme = await Deno.readTextFile(new URL("../README.md", import.meta.url));
  assertEquals(
    inspectTemporallyNeutralReadme(readme, {
      version: packageVersion,
      image: "ghcr.io/superworldsavior/mcp-modelica",
    }),
    {
      ok: true,
      violations: [],
    },
  );
});

Deno.test("verifier succeeds when published bytes match advertised digests on every layer", async () => {
  const registry = await successfulRegistry();
  const result = await verifyPublishedRelease({
    version: VERSION,
    commit: COMMIT,
    fetch: registry.fetch,
  });
  assertEquals(result.ok, true);
  assertEquals(result.version, VERSION);
  assertEquals(result.jsrVersion, VERSION);
  assertEquals(result.commit, COMMIT);
  assertEquals(result.jsrPackage, JSR_PACKAGE_NAME);
  assertEquals(result.image, GHCR_IMAGE_NAME);
  assertEquals(result.indexDigest, registry.indexDigest);
  assertEquals(result.platforms, [
    { os: "linux", architecture: "amd64", digest: registry.amd64ManifestDigest },
    { os: "linux", architecture: "arm64", digest: registry.arm64ManifestDigest },
  ]);
  const cli = renderPublishedReleaseCli({ status: "verified", result });
  assertEquals(cli.exitCode, 0);
  assert(cli.stderr.includes(`Published release ${VERSION} verified`));
  assert(!Object.hasOwn(JSON.parse(cli.stdout) as object, "jsrCommit"));
});

Deno.test("verifier fails closed when the published JSR version is absent", async () => {
  const registry = await successfulRegistry();
  registry.jsrMeta.versions = {};
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "jsr_version_missing");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier binds README bytes to the JSR manifest checksum and size", async () => {
  const registry = await successfulRegistry();
  registry.readme = `${registry.readme}\nextra\n`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "jsr_readme_checksum_mismatch");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier fails closed when the JSR README checksum is malformed", async () => {
  const registry = await successfulRegistry();
  registry.jsrVersionMeta.manifest["/README.md"].checksum = "sha256:not-sri";
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "jsr_readme_malformed_checksum");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier shows the published deno.json version and does not invent JSR commit provenance", async () => {
  const registry = await successfulRegistry();
  registry.publishedDenoJson = JSON.stringify({ name: JSR_PACKAGE_NAME, version: "0.0.1" }) + "\n";
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "jsr_deno_json_checksum_mismatch");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier fails closed when published deno.json version disagrees with the tag", async () => {
  const registry = await successfulRegistry();
  const wrong = JSON.stringify({ name: JSR_PACKAGE_NAME, version: "9.9.9" }, null, 2) + "\n";
  registry.publishedDenoJson = wrong;
  registry.jsrVersionMeta.manifest["/deno.json"] = await sri(wrong);
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "jsr_version_mismatch");
  assertEquals(error.context.jsrVersion, "9.9.9");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier fails closed when the published JSR README is missing from package metadata", async () => {
  const registry = await successfulRegistry();
  registry.jsrVersionMeta.manifest = {
    "/deno.json": registry.jsrVersionMeta.manifest["/deno.json"],
  };
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "jsr_readme_missing");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier fails closed when GHCR does not resolve to an OCI index", async () => {
  const registry = await successfulRegistry();
  registry.index.mediaType = OCI_MANIFEST;
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_index_not_oci");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier hashes fetched OCI index bytes against docker-content-digest", async () => {
  const registry = await successfulRegistry();
  registry.indexDigestHeader = FAKE_DIGEST;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_index_digest_mismatch");
  assertEquals(error.context.expected, FAKE_DIGEST);
  assertEquals(error.context.actual, registry.indexDigest);
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier hashes native manifest bytes against the index descriptor digest", async () => {
  const registry = await successfulRegistry();
  registry.index.manifests[0].digest = FAKE_DIGEST;
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  registry.manifestBodies[FAKE_DIGEST] = registry.manifestBodies[registry.amd64ManifestDigest];
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_manifest_digest_mismatch");
  assertEquals(error.context.expected, FAKE_DIGEST);
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier hashes config bytes against the manifest config digest", async () => {
  const registry = await successfulRegistry();
  const manifest = JSON.parse(registry.manifestBodies[registry.amd64ManifestDigest]) as {
    config: { digest: string };
  };
  manifest.config.digest = FAKE_DIGEST;
  const manifestHashed = await jsonDigest(manifest);
  registry.manifestBodies[manifestHashed.digest] = manifestHashed.body;
  registry.configBodies[FAKE_DIGEST] = registry.configBodies[registry.amd64ConfigDigest];
  registry.index.manifests[0].digest = manifestHashed.digest;
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_config_digest_mismatch");
  assertEquals(error.context.expected, FAKE_DIGEST);
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier requires schemaVersion 2 and a native OCI manifest mediaType", async () => {
  const registry = await successfulRegistry();
  registry.index.schemaVersion = 1;
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_index_schema_invalid");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier fails closed when a native platform is missing from the index", async () => {
  const registry = await successfulRegistry();
  registry.index.manifests = registry.index.manifests.filter((manifest) => {
    const platform = manifest.platform as { architecture?: string } | undefined;
    return platform?.architecture !== "arm64";
  });
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_native_platform_missing");
  assertEquals(error.context.missing, "linux/arm64");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier rejects duplicate native platforms", async () => {
  const registry = await successfulRegistry();
  registry.index.manifests.push({
    mediaType: OCI_MANIFEST,
    digest: registry.amd64ManifestDigest,
    platform: { os: "linux", architecture: "amd64" },
  });
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_duplicate_native_platform");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier rejects a malformed descriptor instead of skipping a missing platform", async () => {
  const registry = await successfulRegistry();
  registry.index.manifests.push({
    mediaType: OCI_MANIFEST,
    digest: ATTESTATION_DIGEST,
  });
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_malformed_descriptor");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier rejects an unexpected published native platform", async () => {
  const registry = await successfulRegistry();
  registry.index.manifests.push({
    mediaType: OCI_MANIFEST,
    digest: FAKE_DIGEST,
    platform: { os: "linux", architecture: "s390x" },
  });
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_unexpected_native_platform");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier skips only an explicit well-formed attestation descriptor", async () => {
  const registry = await successfulRegistry();
  const result = await verifyPublishedRelease({
    version: VERSION,
    commit: COMMIT,
    fetch: registry.fetch,
  });
  assertEquals(result.platforms.map((platform) => platform.architecture), ["amd64", "arm64"]);
});

Deno.test("verifier rejects an attestation marker that is missing a digest", async () => {
  const registry = await successfulRegistry();
  registry.index.manifests[1] = {
    mediaType: OCI_MANIFEST,
    platform: { os: "unknown", architecture: "unknown" },
    annotations: { "vnd.docker.reference.type": "attestation-manifest" },
  };
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_malformed_descriptor");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier rejects an attestation marker without unknown OCI descriptor fields", async () => {
  const registry = await successfulRegistry();
  registry.index.manifests[1] = {
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    digest: ATTESTATION_DIGEST,
    platform: { os: "linux", architecture: "amd64" },
    annotations: { "vnd.docker.reference.type": "attestation-manifest" },
  };
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_manifest_media_type");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier requires config os/architecture to equal the descriptor", async () => {
  const registry = await successfulRegistry();
  const config = JSON.parse(registry.configBodies[registry.amd64ConfigDigest]) as {
    architecture: string;
    os: string;
  };
  config.architecture = "arm64";
  const configHashed = await jsonDigest(config);
  const manifestHashed = await jsonDigest(nativeManifest(configHashed.digest));
  registry.configBodies[configHashed.digest] = configHashed.body;
  registry.manifestBodies[manifestHashed.digest] = manifestHashed.body;
  registry.index.manifests[0].digest = manifestHashed.digest;
  registry.indexBody = JSON.stringify(registry.index);
  registry.indexDigest = `sha256:${await sha256(registry.indexBody)}`;
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_platform_mismatch");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier fails closed when a native config version label mismatches the release tag", async () => {
  const registry = await successfulRegistry({
    amd64Version: "0.6.4",
  });
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_label_mismatch");
  assertEquals(error.context.platform, "linux/amd64");
  assertEquals(error.context.label, "org.opencontainers.image.version");
  refuteVerifiedAnnouncement(error);
});

Deno.test("verifier fails closed when a native config revision label mismatches the tag commit", async () => {
  const registry = await successfulRegistry({
    arm64Revision: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  const error = await rejectVerifier(() =>
    verifyPublishedRelease({
      version: VERSION,
      commit: COMMIT,
      fetch: registry.fetch,
    })
  );
  assertEquals(error.code, "ghcr_label_mismatch");
  assertEquals(error.context.platform, "linux/arm64");
  assertEquals(error.context.label, "org.opencontainers.image.revision");
  refuteVerifiedAnnouncement(error);
});

Deno.test("annotated v0.6.4 tag fixture peels to the verified release commit", async () => {
  const fetchImpl: FetchLike = (input) => {
    const url = String(input);
    if (url === `https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${V064_RELEASE_TAG}`) {
      return jsonResponse({
        ref: `refs/tags/${V064_RELEASE_TAG}`,
        object: {
          sha: V064_ANNOTATED_TAG_OBJECT,
          type: "tag",
        },
      });
    }
    if (
      url ===
        `https://api.github.com/repos/${REPOSITORY}/git/tags/${V064_ANNOTATED_TAG_OBJECT}`
    ) {
      return jsonResponse({
        sha: V064_ANNOTATED_TAG_OBJECT,
        object: { sha: V064_RELEASE_COMMIT, type: "commit" },
        tag: V064_RELEASE_TAG,
      });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  };
  assertEquals(
    await resolveReleaseTagCommit({
      repository: REPOSITORY,
      tag: V064_RELEASE_TAG,
      token: "fixture",
      fetch: fetchImpl,
    }),
    V064_RELEASE_COMMIT,
  );
});

Deno.test("lightweight tag resolution uses the commit object sha", async () => {
  const fetchImpl: FetchLike = (input) => {
    const url = String(input);
    if (url.endsWith(`/git/ref/tags/v0.6.5`)) {
      return jsonResponse({
        ref: "refs/tags/v0.6.5",
        object: { sha: COMMIT, type: "commit" },
      });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  };
  assertEquals(
    await resolveReleaseTagCommit({
      repository: REPOSITORY,
      tag: "v0.6.5",
      token: "fixture",
      fetch: fetchImpl,
    }),
    COMMIT,
  );
});

Deno.test("tag resolution fails when the peeled commit does not equal head_sha", async () => {
  const fetchImpl: FetchLike = (input) => {
    const url = String(input);
    if (url.endsWith(`/git/ref/tags/${V064_RELEASE_TAG}`)) {
      return jsonResponse({
        object: { sha: V064_ANNOTATED_TAG_OBJECT, type: "tag" },
      });
    }
    if (url.endsWith(`/git/tags/${V064_ANNOTATED_TAG_OBJECT}`)) {
      return jsonResponse({
        object: { sha: V064_RELEASE_COMMIT, type: "commit" },
      });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  };
  const tagCommit = await resolveReleaseTagCommit({
    repository: REPOSITORY,
    tag: V064_RELEASE_TAG,
    token: "fixture",
    fetch: fetchImpl,
  });
  assertEquals(tagCommit, V064_RELEASE_COMMIT);
  assert(tagCommit !== COMMIT);
});

Deno.test("originating workflow_run must be same-repo push success of a publisher path and exact tag", () => {
  const trusted = assertOriginatingWorkflowRun({
    repository: REPOSITORY,
    headRepositoryFullName: REPOSITORY,
    event: "push",
    conclusion: "success",
    path: JSR_PUBLISH_WORKFLOW_PATH,
    headBranch: "v0.6.5",
    headSha: COMMIT,
  });
  assertEquals(trusted, {
    tag: "v0.6.5",
    headSha: COMMIT,
    path: JSR_PUBLISH_WORKFLOW_PATH,
  });
  assertEquals(
    rejectSync(() =>
      assertOriginatingWorkflowRun({
        repository: REPOSITORY,
        headRepositoryFullName: "evil/fork",
        event: "push",
        conclusion: "success",
        path: JSR_PUBLISH_WORKFLOW_PATH,
        headBranch: "v0.6.5",
        headSha: COMMIT,
      })
    ).code,
    "untrusted_workflow_run",
  );
  assertEquals(
    rejectSync(() =>
      assertOriginatingWorkflowRun({
        repository: REPOSITORY,
        headRepositoryFullName: REPOSITORY,
        event: "pull_request",
        conclusion: "success",
        path: JSR_PUBLISH_WORKFLOW_PATH,
        headBranch: "v0.6.5",
        headSha: COMMIT,
      })
    ).code,
    "untrusted_workflow_run",
  );
  assertEquals(
    rejectSync(() =>
      assertOriginatingWorkflowRun({
        repository: REPOSITORY,
        headRepositoryFullName: REPOSITORY,
        event: "push",
        conclusion: "failure",
        path: JSR_PUBLISH_WORKFLOW_PATH,
        headBranch: "v0.6.5",
        headSha: COMMIT,
      })
    ).code,
    "untrusted_workflow_run",
  );
  assertEquals(
    rejectSync(() =>
      assertOriginatingWorkflowRun({
        repository: REPOSITORY,
        headRepositoryFullName: REPOSITORY,
        event: "push",
        conclusion: "success",
        path: ".github/workflows/check.yml",
        headBranch: "v0.6.5",
        headSha: COMMIT,
      })
    ).code,
    "untrusted_workflow_run",
  );
  assertEquals(
    rejectSync(() =>
      assertOriginatingWorkflowRun({
        repository: REPOSITORY,
        headRepositoryFullName: REPOSITORY,
        event: "push",
        conclusion: "success",
        path: JSR_PUBLISH_WORKFLOW_PATH,
        headBranch: "v0.6.4-rc.1",
        headSha: COMMIT,
      })
    ).code,
    "invalid_release_identity",
  );
});

Deno.test("coordinator matches publisher workflow path and identity, not the display name", () => {
  const runs = [
    publisherRun({
      path: JSR_PUBLISH_WORKFLOW_PATH,
      name: "unrelated display name",
      tag: "v0.6.5",
      commit: COMMIT,
      conclusion: "success",
      runNumber: 2,
    }),
    publisherRun({
      path: GHCR_PUBLISH_WORKFLOW_PATH,
      name: GHCR_PUBLISH_WORKFLOW_NAME,
      tag: "v0.6.5",
      commit: COMMIT,
      conclusion: "success",
      runNumber: 3,
    }),
  ];
  assertEquals(
    publicationStatusesFromWorkflowRuns(runs, {
      repository: REPOSITORY,
      tag: "v0.6.5",
      commit: COMMIT,
    }),
    { jsr: "success", ghcr: "success" },
  );
  assertEquals(
    publicationStatusesFromWorkflowRuns(
      [
        publisherRun({
          path: ".github/workflows/evil.yml",
          name: JSR_PUBLISH_WORKFLOW_NAME,
          tag: "v0.6.5",
          commit: COMMIT,
          conclusion: "success",
          runNumber: 9,
        }),
        ...runs.slice(1),
      ],
      { repository: REPOSITORY, tag: "v0.6.5", commit: COMMIT },
    ),
    { jsr: "missing", ghcr: "success" },
  );
});

Deno.test("coordinator rejects a successful publisher sibling for another tag or commit", () => {
  const error = rejectSync(() =>
    publicationStatusesFromWorkflowRuns(
      [
        publisherRun({
          path: JSR_PUBLISH_WORKFLOW_PATH,
          name: JSR_PUBLISH_WORKFLOW_NAME,
          tag: "v0.6.4",
          commit: V064_RELEASE_COMMIT,
          conclusion: "success",
          runNumber: 8,
        }),
      ],
      { repository: REPOSITORY, tag: "v0.6.5", commit: COMMIT },
    )
  );
  assertEquals(error.code, "sibling_publication_mismatch");
  refuteVerifiedAnnouncement(error);
});

Deno.test("publication coordination waits instead of verifying when a sibling is still running", () => {
  assertEquals(
    coordinatePublishedReleaseVerifier({ jsr: "success", ghcr: "in_progress" }),
    {
      action: "wait",
      reason: "GHCR publication has not completed",
    },
  );
  assertEquals(
    coordinatePublishedReleaseVerifier({ jsr: "queued", ghcr: "success" }),
    {
      action: "wait",
      reason: "JSR publication has not completed",
    },
  );
  const cli = renderPublishedReleaseCli({
    status: "waiting_for_sibling",
    reason: "GHCR publication has not completed",
  });
  assertEquals(cli.exitCode, 0);
  refuteVerifiedAnnouncement(cli);
});

Deno.test("publication coordination fails closed when either publication failed", () => {
  assertEquals(
    coordinatePublishedReleaseVerifier({ jsr: "failure", ghcr: "success" }),
    {
      action: "fail",
      reason: "JSR publication did not succeed",
      code: "sibling_publication_failed",
    },
  );
  assertEquals(
    coordinatePublishedReleaseVerifier({ jsr: "success", ghcr: "cancelled" }),
    {
      action: "fail",
      reason: "GHCR publication did not succeed",
      code: "sibling_publication_failed",
    },
  );
  const cli = renderPublishedReleaseCli({
    status: "failed",
    error: new PublishedReleaseVerifierError(
      "sibling_publication_failed",
      { workflow: GHCR_PUBLISH_WORKFLOW_NAME },
      "Do not announce the release as verified. Inspect the failed publication workflow.",
    ),
  });
  assertEquals(cli.exitCode, 1);
  refuteVerifiedAnnouncement(cli);
});

Deno.test("publication coordination verifies only after both publications succeed", () => {
  assertEquals(
    coordinatePublishedReleaseVerifier({ jsr: "success", ghcr: "success" }),
    { action: "verify" },
  );
  assertEquals(JSR_PUBLISH_WORKFLOW_NAME, "Publish JSR");
  assertEquals(GHCR_PUBLISH_WORKFLOW_NAME, "Publish container image");
  assertEquals(JSR_PUBLISH_WORKFLOW_PATH, ".github/workflows/publish.yml");
  assertEquals(GHCR_PUBLISH_WORKFLOW_PATH, ".github/workflows/publish-image.yml");
});

Deno.test("publication coordination retries a missing sibling instead of skipping verification", async () => {
  const loads: Array<{ jsr: PublicationStatus; ghcr: PublicationStatus }> = [
    { jsr: "success", ghcr: "missing" },
    { jsr: "success", ghcr: "success" },
  ];
  const sleeps: number[] = [];
  const decision = await waitForPublicationPair({
    load: () => loads.shift() ?? { jsr: "success", ghcr: "success" },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    attempts: 6,
    delayMs: 5000,
  });
  assertEquals(decision, { action: "verify" });
  assertEquals(sleeps, [5000]);
});

Deno.test("publication coordination still waits after retries when the sibling is running", async () => {
  const decision = await waitForPublicationPair({
    load: () => ({ jsr: "success", ghcr: "in_progress" }),
    sleep: () => Promise.resolve(),
    attempts: 3,
    delayMs: 1,
  });
  assertEquals(decision, {
    action: "wait",
    reason: "GHCR publication has not completed",
  });
  const cli = renderPublishedReleaseCli({
    status: "waiting_for_sibling",
    reason: "GHCR publication has not completed",
  });
  refuteVerifiedAnnouncement(cli);
});

Deno.test("CLI skips a leading -- so deno task separators do not become identity arguments", () => {
  assertEquals(parseCli(["--", "--tag", "v0.6.5", "--commit", COMMIT]), {
    tag: "v0.6.5",
    version: VERSION,
    commit: COMMIT,
    coordinate: false,
    evidencePath: "",
  });
});

Deno.test("CLI verifies the explicitly selected personal image and its matching README", async () => {
  const image = "ghcr.io/superworldsavior/mcp-modelica";
  const registry = await successfulRegistry();
  registry.readme = NEUTRAL_README.replaceAll(GHCR_IMAGE_NAME, image);
  registry.jsrVersionMeta.manifest["/README.md"] = await sri(registry.readme);
  const requested: string[] = [];
  const result = await runPublishedReleaseCli(
    ["--tag", `v${VERSION}`, "--commit", COMMIT, "--image", image],
    {
      fetch: (input) => {
        const url = String(input);
        requested.push(url);
        return registry.fetch(
          url.replaceAll("superworldsavior/mcp-modelica", "casys-ai/mcp-modelica"),
        );
      },
    },
  );
  assertEquals(result.exitCode, 0);
  assertEquals(JSON.parse(result.stdout).image, image);
  assert(requested.some((url) => url.includes("/v2/superworldsavior/mcp-modelica/")));
  assert(!requested.some((url) => url.includes("/v2/casys-ai/mcp-modelica/")));
});

Deno.test("personal image verification refuses a README still advertising the old namespace", async () => {
  const registry = await successfulRegistry();
  const result = await runPublishedReleaseCli(
    [
      "--tag",
      `v${VERSION}`,
      "--commit",
      COMMIT,
      "--image",
      "ghcr.io/superworldsavior/mcp-modelica",
    ],
    { fetch: registry.fetch },
  );
  assertEquals(result.exitCode, 1);
  assertEquals(JSON.parse(result.stdout).code, "published_readme_not_neutral");
  refuteVerifiedAnnouncement(result);
});

Deno.test("CLI refuses tagged, digest-bound or unrelated image coordinates", () => {
  for (
    const image of [
      "ghcr.io/superworldsavior/mcp-modelica:0.6.5",
      `ghcr.io/superworldsavior/mcp-modelica@${FAKE_DIGEST}`,
      "ghcr.io/superworldsavior/another-package",
    ]
  ) {
    let rejected = false;
    try {
      parseCli(["--tag", `v${VERSION}`, "--commit", COMMIT, "--image", image]);
    } catch (error) {
      rejected = error instanceof PublishedReleaseVerifierError &&
        error.code === "invalid_release_identity";
    }
    assert(rejected, `accepted unsafe coordinate ${image}`);
  }
});

Deno.test("actual CLI command fails closed on an invalid tag and does not write evidence", async () => {
  const directory = await Deno.makeTempDir({ prefix: "verify-published-cli-fail-" });
  const evidence = `${directory}/published-release.json`;
  try {
    const output = await runCliCommand([
      "--tag",
      "not-a-tag",
      "--commit",
      COMMIT,
      "--evidence",
      evidence,
    ]);
    assertEquals(output.code, 1);
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assert(stdout.includes("invalid_release_identity"));
    refuteVerifiedAnnouncement({ stdout, stderr });
    assertEquals(await exists(evidence), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("actual CLI command verifies through the workflow deno-run invocation and writes evidence only then", async () => {
  const registry = await successfulRegistry();
  const directory = await Deno.makeTempDir({ prefix: "verify-published-cli-ok-" });
  const evidence = `${directory}/published-release.json`;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => registry.serve(request),
  );
  try {
    const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
    const output = await runCliCommand(
      ["--tag", `v${VERSION}`, "--commit", COMMIT, "--evidence", evidence],
      {
        JSR_IO_ORIGIN: origin,
        GHCR_ORIGIN: origin,
      },
    );
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    const payload = JSON.parse(stdout) as {
      status: string;
      jsrVersion: string;
      indexDigest: string;
    };
    assertEquals(payload.status, "verified");
    assertEquals(payload.jsrVersion, VERSION);
    assertEquals(payload.indexDigest, registry.indexDigest);
    assert(stderr.includes(`Published release ${VERSION} verified`));
    assertEquals(await Deno.readTextFile(evidence), stdout);
  } finally {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CLI coordination wait does not emit verified and does not persist evidence", async () => {
  const directory = await Deno.makeTempDir({ prefix: "verify-published-cli-wait-" });
  const evidence = `${directory}/published-release.json`;
  try {
    const rendered = await runPublishedReleaseCli(
      ["--tag", "v0.6.5", "--commit", COMMIT, "--coordinate", "--evidence", evidence],
      {
        attempts: 1,
        delayMs: 0,
        env: (name) =>
          ({
            GITHUB_REPOSITORY: REPOSITORY,
            TRIGGER_HEAD_REPOSITORY: REPOSITORY,
            TRIGGER_EVENT: "push",
            TRIGGER_CONCLUSION: "success",
            TRIGGER_WORKFLOW_PATH: JSR_PUBLISH_WORKFLOW_PATH,
            TRIGGER_HEAD_BRANCH: "v0.6.5",
            TRIGGER_HEAD_SHA: COMMIT,
            GH_TOKEN: "fixture",
          })[name],
        fetch: (input) => {
          const url = String(input);
          if (url.endsWith(`/git/ref/tags/v0.6.5`)) {
            return jsonResponse({ object: { sha: COMMIT, type: "commit" } });
          }
          if (url.includes("/actions/runs?")) {
            return jsonResponse({
              workflow_runs: [
                publisherRun({
                  path: JSR_PUBLISH_WORKFLOW_PATH,
                  name: JSR_PUBLISH_WORKFLOW_NAME,
                  tag: "v0.6.5",
                  commit: COMMIT,
                  conclusion: "success",
                  runNumber: 1,
                }),
              ],
            });
          }
          return new Response(`unexpected ${url}`, { status: 404 });
        },
      },
    );
    assertEquals(rendered.exitCode, 0);
    assertEquals(rendered.evidenceWritten, false);
    assertEquals(JSON.parse(rendered.stdout).status, "waiting_for_sibling");
    refuteVerifiedAnnouncement(rendered);
    assertEquals(await exists(evidence), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("deno task forwards flags without -- and forwards a leading -- when separated", async () => {
  const withoutSeparator = await new Deno.Command(Deno.execPath(), {
    args: ["task", "verify:published", "--tag", "not-a-tag", "--commit", COMMIT],
    cwd: fromFileUrl(new URL("../", import.meta.url)),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const withoutStdout = new TextDecoder().decode(withoutSeparator.stdout);
  assertEquals(withoutSeparator.code, 1);
  assert(withoutStdout.includes("invalid_release_identity"));
  assert(!withoutStdout.includes('"argument":"--"'));

  const withSeparator = await new Deno.Command(Deno.execPath(), {
    args: ["task", "verify:published", "--", "--tag", "not-a-tag", "--commit", COMMIT],
    cwd: fromFileUrl(new URL("../", import.meta.url)),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const withStdout = new TextDecoder().decode(withSeparator.stdout);
  assertEquals(withSeparator.code, 1);
  assert(withStdout.includes("invalid_release_identity"));
  assert(
    !withStdout.includes('"argument":"--"'),
    "a forwarded leading -- must be skipped rather than treated as an identity argument",
  );
});

async function rejectVerifier(run: () => Promise<unknown>): Promise<PublishedReleaseVerifierError> {
  return await assertRejects(run, PublishedReleaseVerifierError);
}

function rejectSync(run: () => unknown): PublishedReleaseVerifierError {
  try {
    run();
  } catch (error) {
    if (error instanceof PublishedReleaseVerifierError) return error;
    throw error;
  }
  throw new Error("expected PublishedReleaseVerifierError");
}

function refuteVerifiedAnnouncement(
  value: { stderr?: string; stdout?: string; message?: string; toJSON?: () => unknown },
): void {
  const rendered = [
    value.stderr ?? "",
    value.stdout ?? "",
    value.message ?? "",
    value.toJSON ? JSON.stringify(value.toJSON()) : "",
  ].join("\n");
  assert(
    !/Published release \S+ verified/.test(rendered),
    "A failed or waiting check must not announce the release as verified.",
  );
  assert(
    !/"status":"verified"/.test(rendered),
    "A failed or waiting check must not emit status verified.",
  );
}

async function successfulRegistry(options: {
  amd64Version?: string;
  arm64Revision?: string;
} = {}) {
  const amd64Config = platformConfig("amd64", options.amd64Version ?? VERSION, COMMIT);
  const arm64Config = platformConfig(
    "arm64",
    VERSION,
    options.arm64Revision ?? COMMIT,
  );
  const amd64ConfigHashed = await jsonDigest(amd64Config);
  const arm64ConfigHashed = await jsonDigest(arm64Config);
  const amd64Manifest = nativeManifest(amd64ConfigHashed.digest);
  const arm64Manifest = nativeManifest(arm64ConfigHashed.digest);
  const amd64ManifestHashed = await jsonDigest(amd64Manifest);
  const arm64ManifestHashed = await jsonDigest(arm64Manifest);
  const index: {
    schemaVersion: number;
    mediaType: string;
    manifests: Array<Record<string, unknown>>;
  } = {
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [
      {
        mediaType: OCI_MANIFEST,
        digest: amd64ManifestHashed.digest,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: OCI_MANIFEST,
        digest: ATTESTATION_DIGEST,
        platform: { os: "unknown", architecture: "unknown" },
        annotations: { "vnd.docker.reference.type": "attestation-manifest" },
      },
      {
        mediaType: OCI_MANIFEST,
        digest: arm64ManifestHashed.digest,
        platform: { os: "linux", architecture: "arm64" },
      },
    ],
  };
  const indexHashed = await jsonDigest(index);
  const readmeChecksum = await sri(NEUTRAL_README);
  const denoJsonChecksum = await sri(PUBLISHED_DENO_JSON);
  const jsrMeta: { versions: Record<string, { createdAt: string }> } = {
    versions: { [VERSION]: { createdAt: "2026-09-08T00:00:00.000Z" } },
  };
  const jsrVersionMeta: {
    manifest: Record<string, { size: number; checksum: string }>;
  } = {
    manifest: {
      "/README.md": readmeChecksum,
      "/deno.json": denoJsonChecksum,
    },
  };
  const registry = {
    jsrMeta,
    jsrVersionMeta,
    readme: NEUTRAL_README,
    publishedDenoJson: PUBLISHED_DENO_JSON,
    index,
    indexBody: indexHashed.body,
    indexDigest: indexHashed.digest,
    indexDigestHeader: undefined as string | undefined,
    amd64ManifestDigest: amd64ManifestHashed.digest,
    arm64ManifestDigest: arm64ManifestHashed.digest,
    amd64ConfigDigest: amd64ConfigHashed.digest,
    arm64ConfigDigest: arm64ConfigHashed.digest,
    manifestBodies: {
      [amd64ManifestHashed.digest]: amd64ManifestHashed.body,
      [arm64ManifestHashed.digest]: arm64ManifestHashed.body,
    } as Record<string, string>,
    configBodies: {
      [amd64ConfigHashed.digest]: amd64ConfigHashed.body,
      [arm64ConfigHashed.digest]: arm64ConfigHashed.body,
    } as Record<string, string>,
    unavailable: new Set<string>(),
    fetch: (input: string | URL): Response => {
      const url = String(input);
      return respond(url) ?? new Response(`unexpected ${url}`, { status: 404 });
    },
    serve: (request: Request): Response => {
      const url = new URL(request.url);
      const mapped = url.pathname.startsWith("/token")
        ? `${url.origin}${url.pathname}${url.search}`
        : `${url.origin}${url.pathname}`;
      return respond(mapped) ?? new Response(`unexpected ${mapped}`, { status: 404 });
    },
  };

  function respond(url: string): Response | undefined {
    if (registry.unavailable.has(url)) {
      return new Response("unavailable", { status: 503 });
    }
    if (url.endsWith(`/${JSR_PACKAGE_NAME}/meta.json`)) {
      return jsonResponse(jsrMeta);
    }
    if (url.endsWith(`/${JSR_PACKAGE_NAME}/${VERSION}_meta.json`)) {
      return jsonResponse(jsrVersionMeta);
    }
    if (url.endsWith(`/${JSR_PACKAGE_NAME}/${VERSION}/README.md`)) {
      return new Response(registry.readme, { status: 200 });
    }
    if (url.endsWith(`/${JSR_PACKAGE_NAME}/${VERSION}/deno.json`)) {
      return new Response(registry.publishedDenoJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/token?")) {
      return jsonResponse({ token: "fixture-token" });
    }
    const image = GHCR_IMAGE_NAME.replace("ghcr.io/", "");
    if (url.endsWith(`/v2/${image}/manifests/${VERSION}`)) {
      return new Response(registry.indexBody, {
        status: 200,
        headers: {
          "content-type": OCI_INDEX,
          "docker-content-digest": registry.indexDigestHeader ?? registry.indexDigest,
        },
      });
    }
    const manifestMatch = url.match(/\/manifests\/(sha256:[a-f0-9]{64})$/);
    if (manifestMatch) {
      const body = registry.manifestBodies[manifestMatch[1]];
      if (!body) return new Response("missing manifest", { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { "content-type": OCI_MANIFEST },
      });
    }
    const blobMatch = url.match(/\/blobs\/(sha256:[a-f0-9]{64})$/);
    if (blobMatch) {
      const body = registry.configBodies[blobMatch[1]];
      if (!body) return new Response("missing blob", { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/vnd.oci.image.config.v1+json" },
      });
    }
    return undefined;
  }

  return registry;
}

function platformConfig(architecture: string, version: string, revision: string) {
  return {
    architecture,
    os: "linux",
    config: {
      Labels: {
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.revision": revision,
      },
    },
  };
}

function nativeManifest(configDigest: string) {
  return {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: {
      digest: configDigest,
      mediaType: "application/vnd.oci.image.config.v1+json",
    },
    layers: [],
  };
}

function publisherRun(input: {
  path: string;
  name: string;
  tag: string;
  commit: string;
  conclusion: string;
  runNumber: number;
}) {
  return {
    name: input.name,
    path: input.path,
    head_sha: input.commit,
    head_branch: input.tag,
    event: "push",
    status: "completed",
    conclusion: input.conclusion,
    run_number: input.runNumber,
    head_repository: { full_name: REPOSITORY },
    repository: { full_name: REPOSITORY },
  };
}

async function sri(source: string): Promise<{ size: number; checksum: string }> {
  const bytes = new TextEncoder().encode(source);
  return { size: bytes.byteLength, checksum: `sha256-${await sha256Bytes(bytes)}` };
}

async function jsonDigest(value: unknown): Promise<{ body: string; digest: string }> {
  const body = JSON.stringify(value);
  return { body, digest: `sha256:${await sha256(body)}` };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function runCliCommand(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<Deno.CommandOutput> {
  return await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net=127.0.0.1",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "scripts/verify-published-release.ts",
      ...args,
    ],
    cwd: fromFileUrl(new URL("../", import.meta.url)),
    env: { ...Deno.env.toObject(), ...extraEnv },
    stdout: "piped",
    stderr: "piped",
  }).output();
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
