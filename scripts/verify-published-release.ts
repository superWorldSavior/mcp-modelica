/**
 * Post-publication proof that the exact tagged JSR package and GHCR image exist.
 *
 * The packaged README is checked from the published JSR artifact, not from the
 * local checkout, so a later documentation commit cannot mask stale package docs.
 * JSR version metadata does not carry a git commit; commit identity comes from the
 * annotated tag peel and GHCR revision labels, not from independent JSR provenance.
 */
import { sha256Bytes } from "../src/domain/hashing.ts";

export const JSR_PACKAGE_NAME = "@casys/mcp-modelica";
export const GHCR_IMAGE_NAME = "ghcr.io/casys-ai/mcp-modelica";
export const JSR_PUBLISH_WORKFLOW_NAME = "Publish JSR";
export const GHCR_PUBLISH_WORKFLOW_NAME = "Publish container image";
export const JSR_PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yml";
export const GHCR_PUBLISH_WORKFLOW_PATH = ".github/workflows/publish-image.yml";
export const MODELICA_IMAGE_DIGEST_VARIABLE = "MODELICA_IMAGE_DIGEST";

const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const EXPECTED_NATIVE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
const VERSION_LABEL = "org.opencontainers.image.version";
const REVISION_LABEL = "org.opencontainers.image.revision";
const USER_AGENT = "Casys-mcp-modelica-release-verifier";
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const JSR_CHECKSUM = /^sha256-[a-f0-9]{64}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const RELEASE_COMMIT = /^[0-9a-f]{40}$/;

export type PublicationStatus =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "in_progress"
  | "queued"
  | "missing";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

export interface PublishedReleaseVerifierContext {
  readonly [key: string]: string | number | boolean;
}

export class PublishedReleaseVerifierError extends Error {
  constructor(
    readonly code: string,
    readonly context: PublishedReleaseVerifierContext = {},
    readonly recovery =
      "Do not announce the release as verified. Inspect the failed publication surface.",
  ) {
    super(code);
    this.name = "PublishedReleaseVerifierError";
  }

  toJSON() {
    return { code: this.code, context: this.context, recovery: this.recovery };
  }
}

export interface ReadmeNeutralityReport {
  ok: boolean;
  violations: string[];
}

export interface VerifyPublishedReleaseInput {
  version: string;
  commit: string;
  jsrPackage?: string;
  image?: string;
  fetch?: FetchLike;
  env?: EnvGetter;
}

export interface VerifiedPublishedRelease {
  ok: true;
  version: string;
  commit: string;
  jsrPackage: string;
  jsrVersion: string;
  image: string;
  indexDigest: string;
  platforms: Array<{ os: string; architecture: string; digest: string }>;
}

export type PublicationCoordination =
  | { action: "verify" }
  | { action: "wait"; reason: string }
  | { action: "fail"; reason: string; code: "sibling_publication_failed" };

export type PublishedReleaseCliResult =
  | { status: "verified"; result: VerifiedPublishedRelease }
  | { status: "waiting_for_sibling"; reason: string }
  | { status: "failed"; error: PublishedReleaseVerifierError };

export type EnvGetter = (name: string) => string | undefined;

export interface PublishedReleaseCliOptions {
  fetch?: FetchLike;
  env?: EnvGetter;
  attempts?: number;
  delayMs?: number;
}

if (import.meta.main) {
  const rendered = await runPublishedReleaseCli(Deno.args);
  Deno.stdout.writeSync(new TextEncoder().encode(rendered.stdout));
  Deno.stderr.writeSync(new TextEncoder().encode(rendered.stderr));
  Deno.exitCode = rendered.exitCode;
}

export async function runPublishedReleaseCli(
  args: readonly string[],
  options: PublishedReleaseCliOptions = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  evidenceWritten: boolean;
}> {
  const envGet = options.env ?? ((name) => Deno.env.get(name));
  const fetchImpl = options.fetch ?? fetch;
  let evidencePath = "";
  try {
    const parsed = parseCli(args);
    evidencePath = parsed.evidencePath;
    if (parsed.coordinate) {
      const originating = assertOriginatingWorkflowRun({
        repository: requiredEnv("GITHUB_REPOSITORY", envGet),
        headRepositoryFullName: requiredEnv("TRIGGER_HEAD_REPOSITORY", envGet),
        event: requiredEnv("TRIGGER_EVENT", envGet),
        conclusion: requiredEnv("TRIGGER_CONCLUSION", envGet),
        path: requiredEnv("TRIGGER_WORKFLOW_PATH", envGet),
        headBranch: requiredEnv("TRIGGER_HEAD_BRANCH", envGet),
        headSha: requiredEnv("TRIGGER_HEAD_SHA", envGet),
      });
      if (originating.tag !== parsed.tag) {
        throw fail("invalid_release_identity", {
          tag: parsed.tag,
          headBranch: originating.tag,
        }, "The originating workflow tag hint must equal --tag.");
      }
      const tagCommit = await resolveReleaseTagCommit({
        repository: requiredEnv("GITHUB_REPOSITORY", envGet),
        tag: parsed.tag,
        token: requiredEnv("GH_TOKEN", envGet),
        fetch: fetchImpl,
        env: envGet,
      });
      if (tagCommit !== parsed.commit || tagCommit !== originating.headSha) {
        throw fail(
          "release_tag_commit_mismatch",
          {
            tag: parsed.tag,
            tagCommit,
            commit: parsed.commit,
            headSha: originating.headSha,
          },
          "Resolve refs/tags/exact, peel annotated tags, and require that commit equals head_sha.",
        );
      }
      const decision = await waitForPublicationPair({
        load: () =>
          loadPublicationPair({
            repository: requiredEnv("GITHUB_REPOSITORY", envGet),
            tag: parsed.tag,
            commit: parsed.commit,
            token: requiredEnv("GH_TOKEN", envGet),
            triggerPath: originating.path,
            triggerConclusion: requiredEnv("TRIGGER_CONCLUSION", envGet),
            fetch: fetchImpl,
            env: envGet,
          }),
        attempts: options.attempts,
        delayMs: options.delayMs,
      });
      if (decision.action === "wait") {
        return finishCli({ status: "waiting_for_sibling", reason: decision.reason }, "");
      }
      if (decision.action === "fail") {
        return finishCli({
          status: "failed",
          error: new PublishedReleaseVerifierError(decision.code, {
            reason: decision.reason,
          }),
        }, "");
      }
    }
    const result = await verifyPublishedRelease({
      version: parsed.version,
      commit: parsed.commit,
      image: parsed.image,
      fetch: fetchImpl,
      env: envGet,
    });
    const rendered = finishCli({ status: "verified", result }, evidencePath);
    if (evidencePath.length > 0) {
      await Deno.writeTextFile(evidencePath, rendered.stdout);
      return { ...rendered, evidenceWritten: true };
    }
    return rendered;
  } catch (error) {
    const wrapped = error instanceof PublishedReleaseVerifierError
      ? error
      : new PublishedReleaseVerifierError(
        "published_release_verification_failed",
        { message: error instanceof Error ? error.message : String(error) },
      );
    return finishCli({ status: "failed", error: wrapped }, "");
  }
}

export function inspectTemporallyNeutralReadme(
  source: string,
  options: { version: string; jsrPackage?: string; image?: string },
): ReadmeNeutralityReport {
  const jsrPackage = options.jsrPackage ?? JSR_PACKAGE_NAME;
  const image = options.image ?? GHCR_IMAGE_NAME;
  const violations: string[] = [];
  if (/\bforthcoming\b/i.test(source)) {
    violations.push("forthcoming");
  }
  if (new RegExp(`${escapeRegExp(image)}@sha256:`, "i").test(source)) {
    violations.push("image-digest-pin");
  }
  const digestVariableRef = `${image}@\${${MODELICA_IMAGE_DIGEST_VARIABLE}:?`;
  if (!source.includes(digestVariableRef)) {
    violations.push("missing-digest-variable");
  }
  if (!new RegExp(`${escapeRegExp(image)}:${escapeRegExp(options.version)}\\b`).test(source)) {
    violations.push("missing-versioned-image-tag");
  }
  if (
    !new RegExp(`${escapeRegExp(`jsr:${jsrPackage}@${options.version}`)}\\b`).test(source)
  ) {
    violations.push("missing-versioned-jsr-specifier");
  }
  if (
    !containsPhrase(source, "after the paired GHCR image publication has succeeded") ||
    !containsPhrase(source, "immutable GHCR index digest")
  ) {
    violations.push("missing-post-publication-digest-guidance");
  }
  return { ok: violations.length === 0, violations };
}

export async function waitForPublicationPair(input: {
  load: () =>
    | { jsr: PublicationStatus; ghcr: PublicationStatus }
    | Promise<{
      jsr: PublicationStatus;
      ghcr: PublicationStatus;
    }>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}): Promise<PublicationCoordination> {
  const attempts = input.attempts ?? 6;
  const delayMs = input.delayMs ?? 5000;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let decision = coordinatePublishedReleaseVerifier(await input.load());
  for (let attempt = 1; attempt < attempts && decision.action === "wait"; attempt += 1) {
    await sleep(delayMs);
    decision = coordinatePublishedReleaseVerifier(await input.load());
  }
  return decision;
}

export function coordinatePublishedReleaseVerifier(input: {
  jsr: PublicationStatus;
  ghcr: PublicationStatus;
}): PublicationCoordination {
  const jsrState = classifyPublication(input.jsr, "JSR");
  const ghcrState = classifyPublication(input.ghcr, "GHCR");
  if (jsrState.kind === "fail") {
    return {
      action: "fail",
      reason: jsrState.reason,
      code: "sibling_publication_failed",
    };
  }
  if (ghcrState.kind === "fail") {
    return {
      action: "fail",
      reason: ghcrState.reason,
      code: "sibling_publication_failed",
    };
  }
  if (jsrState.kind === "wait") {
    return { action: "wait", reason: jsrState.reason };
  }
  if (ghcrState.kind === "wait") {
    return { action: "wait", reason: ghcrState.reason };
  }
  return { action: "verify" };
}

export function assertOriginatingWorkflowRun(input: {
  repository: string;
  headRepositoryFullName: string;
  event: string;
  conclusion: string;
  path: string;
  headBranch: string;
  headSha: string;
}): { tag: string; headSha: string; path: string } {
  if (input.headRepositoryFullName !== input.repository) {
    throw fail("untrusted_workflow_run", {
      repository: input.repository,
      headRepository: input.headRepositoryFullName,
    }, "The originating workflow must run in the same repository, not a fork.");
  }
  if (input.event !== "push") {
    throw fail("untrusted_workflow_run", {
      event: input.event,
    }, "The originating workflow must be a tag push, not another event.");
  }
  if (input.conclusion !== "success") {
    throw fail("untrusted_workflow_run", {
      conclusion: input.conclusion,
    }, "Coordinate only after a successful publisher workflow.");
  }
  if (
    input.path !== JSR_PUBLISH_WORKFLOW_PATH && input.path !== GHCR_PUBLISH_WORKFLOW_PATH
  ) {
    throw fail("untrusted_workflow_run", {
      path: input.path,
    }, "Coordinate only the exact publisher workflow paths.");
  }
  if (!RELEASE_TAG.test(input.headBranch)) {
    throw fail("invalid_release_identity", {
      tag: input.headBranch,
    }, "Treat head_branch as an exact vX.Y.Z tag hint only.");
  }
  const headSha = input.headSha.toLowerCase();
  if (!RELEASE_COMMIT.test(headSha)) {
    throw fail("invalid_release_identity", {
      commit: input.headSha,
    }, "Pass the exact 40-character tag commit.");
  }
  return { tag: input.headBranch, headSha, path: input.path };
}

export async function resolveReleaseTagCommit(input: {
  repository: string;
  tag: string;
  token: string;
  fetch?: FetchLike;
  env?: EnvGetter;
}): Promise<string> {
  if (!RELEASE_TAG.test(input.tag)) {
    throw fail(
      "invalid_release_identity",
      { tag: input.tag },
      "Pass the exact vX.Y.Z release tag.",
    );
  }
  const fetchImpl = input.fetch ?? fetch;
  const envGet = input.env ?? ((name) => Deno.env.get(name));
  const api = githubApiOrigin(envGet);
  const ref = await readJson(
    fetchImpl,
    `${api}/repos/${input.repository}/git/ref/tags/${input.tag}`,
    "release_tag_unavailable",
    { repository: input.repository, tag: input.tag },
    githubHeaders(input.token),
  );
  const object = asRecord(ref.object);
  const objectType = typeof object?.type === "string" ? object.type : "";
  const objectSha = typeof object?.sha === "string" ? object.sha.toLowerCase() : "";
  if (objectType === "commit" && RELEASE_COMMIT.test(objectSha)) {
    return objectSha;
  }
  if (objectType !== "tag" || !RELEASE_COMMIT.test(objectSha)) {
    throw fail("release_tag_unavailable", {
      repository: input.repository,
      tag: input.tag,
      objectType,
    }, "Resolve refs/tags/exact, including annotated tag objects.");
  }
  const peeled = await readJson(
    fetchImpl,
    `${api}/repos/${input.repository}/git/tags/${objectSha}`,
    "release_tag_unavailable",
    { repository: input.repository, tag: input.tag, tagObject: objectSha },
    githubHeaders(input.token),
  );
  const peeledObject = asRecord(peeled.object);
  const peeledType = typeof peeledObject?.type === "string" ? peeledObject.type : "";
  const peeledSha = typeof peeledObject?.sha === "string" ? peeledObject.sha.toLowerCase() : "";
  if (peeledType !== "commit" || !RELEASE_COMMIT.test(peeledSha)) {
    throw fail("release_tag_unavailable", {
      repository: input.repository,
      tag: input.tag,
      peeledType,
    }, "Peel the annotated tag to a commit.");
  }
  return peeledSha;
}

export function publicationStatusesFromWorkflowRuns(
  runs: unknown[],
  input: { repository: string; tag: string; commit: string },
): { jsr: PublicationStatus; ghcr: PublicationStatus } {
  const commit = input.commit.toLowerCase();
  const publisherPaths = new Set([JSR_PUBLISH_WORKFLOW_PATH, GHCR_PUBLISH_WORKFLOW_PATH]);
  for (const run of runs) {
    const record = asRecord(run);
    if (record === undefined) continue;
    const path = typeof record.path === "string" ? record.path : "";
    if (!publisherPaths.has(path)) continue;
    const headSha = typeof record.head_sha === "string" ? record.head_sha.toLowerCase() : "";
    const headBranch = typeof record.head_branch === "string" ? record.head_branch : "";
    const event = typeof record.event === "string" ? record.event : "";
    const conclusion = typeof record.conclusion === "string" ? record.conclusion : "";
    const headRepository = runRepositoryFullName(record);
    const sameIdentity = headSha === commit && headBranch === input.tag;
    if (
      conclusion === "success" && event === "push" && !sameIdentity &&
      (headRepository.length === 0 || headRepository === input.repository)
    ) {
      throw fail("sibling_publication_mismatch", {
        path,
        tag: headBranch,
        commit: headSha,
        expectedTag: input.tag,
        expectedCommit: commit,
      }, "A successful publisher for another tag or commit is not this release.");
    }
  }
  return {
    jsr: latestWorkflowStatus(runs, JSR_PUBLISH_WORKFLOW_PATH, input),
    ghcr: latestWorkflowStatus(runs, GHCR_PUBLISH_WORKFLOW_PATH, input),
  };
}

export async function loadPublicationPair(input: {
  repository: string;
  tag: string;
  commit: string;
  token: string;
  triggerPath: string;
  triggerConclusion: string;
  fetch?: FetchLike;
  env?: EnvGetter;
}): Promise<{ jsr: PublicationStatus; ghcr: PublicationStatus }> {
  const trigger = mapTriggerConclusion(input.triggerConclusion);
  const listed = await listWorkflowStatuses(input);
  const jsr = input.triggerPath === JSR_PUBLISH_WORKFLOW_PATH ? trigger : listed.jsr;
  const ghcr = input.triggerPath === GHCR_PUBLISH_WORKFLOW_PATH ? trigger : listed.ghcr;
  return { jsr, ghcr };
}

export async function verifyPublishedRelease(
  input: VerifyPublishedReleaseInput,
): Promise<VerifiedPublishedRelease> {
  const version = input.version;
  const commit = input.commit.toLowerCase();
  const jsrPackage = input.jsrPackage ?? JSR_PACKAGE_NAME;
  const image = input.image ?? GHCR_IMAGE_NAME;
  const fetchImpl = input.fetch ?? fetch;
  const envGet = input.env ?? ((name) => Deno.env.get(name));
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw fail("invalid_release_identity", { version }, "Pass the exact x.y.z release version.");
  }
  if (!RELEASE_COMMIT.test(commit)) {
    throw fail("invalid_release_identity", { commit }, "Pass the exact 40-character tag commit.");
  }

  const jsrBase = `${jsrOrigin(envGet)}/${jsrPackage}`;
  const jsrMeta = await readJson(
    fetchImpl,
    `${jsrBase}/meta.json`,
    "jsr_metadata_unavailable",
    { jsrPackage },
  );
  const versions = asRecord(jsrMeta.versions);
  if (versions === undefined || !(version in versions)) {
    throw fail(
      "jsr_version_missing",
      { jsrPackage, version },
      "Publish the exact JSR version before verifying.",
    );
  }

  const versionMeta = await readJson(
    fetchImpl,
    `${jsrBase}/${version}_meta.json`,
    "jsr_version_metadata_unavailable",
    { jsrPackage, version },
  );
  const manifest = asRecord(versionMeta.manifest);
  const readmeEntry = asRecord(manifest?.["/README.md"]);
  if (manifest === undefined || readmeEntry === undefined) {
    throw fail(
      "jsr_readme_missing",
      { jsrPackage, version },
      "The published package must include README.md.",
    );
  }
  const denoJsonEntry = asRecord(manifest?.["/deno.json"]);
  if (denoJsonEntry === undefined) {
    throw fail(
      "jsr_deno_json_missing",
      { jsrPackage, version },
      "The published package must include deno.json so the exact version can be shown.",
    );
  }

  const readmeBytes = await readBytes(
    fetchImpl,
    `${jsrBase}/${version}/README.md`,
    "jsr_readme_unavailable",
    { jsrPackage, version },
  );
  await assertPublishedChecksum(
    readmeBytes,
    readmeEntry,
    "jsr_readme_malformed_checksum",
    "jsr_readme_checksum_mismatch",
    { jsrPackage, version },
  );
  const readme = decodeUtf8(readmeBytes, "jsr_readme_unavailable", { jsrPackage, version });
  const neutrality = inspectTemporallyNeutralReadme(readme, { version, jsrPackage, image });
  if (!neutrality.ok) {
    throw fail("published_readme_not_neutral", {
      jsrPackage,
      version,
      violations: neutrality.violations.join(","),
    }, "Ship a temporally neutral README in the tagged JSR package.");
  }

  const denoJsonBytes = await readBytes(
    fetchImpl,
    `${jsrBase}/${version}/deno.json`,
    "jsr_deno_json_unavailable",
    { jsrPackage, version },
  );
  await assertPublishedChecksum(
    denoJsonBytes,
    denoJsonEntry,
    "jsr_deno_json_malformed_checksum",
    "jsr_deno_json_checksum_mismatch",
    { jsrPackage, version },
  );
  const denoJson = parseJsonBytes(
    denoJsonBytes,
    "jsr_deno_json_unavailable",
    { jsrPackage, version },
  );
  const jsrVersion = typeof denoJson.version === "string" ? denoJson.version : "";
  if (jsrVersion !== version) {
    throw fail("jsr_version_mismatch", {
      jsrPackage,
      version,
      jsrVersion,
    }, "The published deno.json version must equal the release version.");
  }

  const repository = image.replace(/^ghcr\.io\//, "");
  const token = await ghcrToken(fetchImpl, repository, envGet);
  const ghcr = ghcrOrigin(envGet);
  const indexUrl = `${ghcr}/v2/${repository}/manifests/${version}`;
  const indexResponse = await request(
    fetchImpl,
    indexUrl,
    {
      Accept: `${OCI_INDEX_MEDIA_TYPE}, ${OCI_MANIFEST_MEDIA_TYPE}`,
      Authorization: `Bearer ${token}`,
    },
    "ghcr_index_unavailable",
    { image, version },
  );
  const indexBytes = await responseBytes(indexResponse);
  const actualIndexDigest = await sha256Digest(indexBytes);
  const indexDigest = indexResponse.headers.get("docker-content-digest");
  if (!indexDigest || !SHA256_DIGEST.test(indexDigest)) {
    throw fail(
      "ghcr_index_digest_missing",
      { image, version },
      "Resolve the immutable OCI index digest from the registry, not from a mutable tag.",
    );
  }
  if (indexDigest !== actualIndexDigest) {
    throw fail("ghcr_index_digest_mismatch", {
      image,
      version,
      expected: indexDigest,
      actual: actualIndexDigest,
    }, "Hash the fetched OCI index bytes; do not trust the digest header alone.");
  }
  const index = parseJsonBytes(indexBytes, "ghcr_index_unavailable", { image, version });
  if (index.schemaVersion !== 2) {
    throw fail(
      "ghcr_index_schema_invalid",
      { image, version, schemaVersion: String(index.schemaVersion ?? "") },
      "Publish a schemaVersion 2 multi-architecture OCI index.",
    );
  }
  const mediaType = typeof index.mediaType === "string" ? index.mediaType : "";
  if (mediaType !== OCI_INDEX_MEDIA_TYPE) {
    throw fail(
      "ghcr_index_not_oci",
      { image, version, mediaType },
      "Publish a multi-architecture OCI index.",
    );
  }

  const nativeManifests = nativePlatformManifests(index);
  const present = new Set(nativeManifests.map((entry) => platformKey(entry.platform)));
  const missing = EXPECTED_NATIVE_PLATFORMS.filter((platform) => !present.has(platform));
  if (missing.length > 0) {
    throw fail("ghcr_native_platform_missing", {
      image,
      version,
      missing: missing.join(","),
    }, "Inspect every published native platform, not the mutable tag alone.");
  }

  const platforms: VerifiedPublishedRelease["platforms"] = [];
  for (const entry of nativeManifests) {
    const platform = platformKey(entry.platform);
    const manifestResponse = await request(
      fetchImpl,
      `${ghcr}/v2/${repository}/manifests/${entry.digest}`,
      {
        Authorization: `Bearer ${token}`,
        Accept: OCI_MANIFEST_MEDIA_TYPE,
      },
      "ghcr_manifest_unavailable",
      { image, version, platform, digest: entry.digest },
    );
    const manifestBytes = await responseBytes(manifestResponse);
    const actualManifestDigest = await sha256Digest(manifestBytes);
    if (actualManifestDigest !== entry.digest) {
      throw fail("ghcr_manifest_digest_mismatch", {
        image,
        version,
        platform,
        expected: entry.digest,
        actual: actualManifestDigest,
      }, "Hash the fetched native manifest bytes against the index descriptor digest.");
    }
    const manifest = parseJsonBytes(manifestBytes, "ghcr_manifest_unavailable", {
      image,
      version,
      platform,
    });
    if (manifest.schemaVersion !== 2) {
      throw fail("ghcr_manifest_schema_invalid", {
        image,
        version,
        platform,
        schemaVersion: String(manifest.schemaVersion ?? ""),
      }, "Each native manifest must use schemaVersion 2.");
    }
    if (manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE) {
      throw fail("ghcr_manifest_media_type", {
        image,
        version,
        platform,
        mediaType: String(manifest.mediaType ?? ""),
      }, "Each native descriptor must be an OCI image manifest.");
    }
    const config = asRecord(manifest.config);
    const configDigest = typeof config?.digest === "string" ? config.digest : "";
    if (!SHA256_DIGEST.test(configDigest)) {
      throw fail(
        "ghcr_config_unavailable",
        { image, version, platform },
        "Read each native image config.",
      );
    }
    const configResponse = await request(
      fetchImpl,
      `${ghcr}/v2/${repository}/blobs/${configDigest}`,
      {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.oci.image.config.v1+json",
      },
      "ghcr_config_unavailable",
      { image, version, platform, digest: configDigest },
    );
    const configBytes = await responseBytes(configResponse);
    const actualConfigDigest = await sha256Digest(configBytes);
    if (actualConfigDigest !== configDigest) {
      throw fail("ghcr_config_digest_mismatch", {
        image,
        version,
        platform,
        expected: configDigest,
        actual: actualConfigDigest,
      }, "Hash the fetched config bytes against the manifest config digest.");
    }
    const configJson = parseJsonBytes(configBytes, "ghcr_config_unavailable", {
      image,
      version,
      platform,
    });
    const configOs = typeof configJson.os === "string" ? configJson.os : "";
    const configArchitecture = typeof configJson.architecture === "string"
      ? configJson.architecture
      : "";
    if (configOs !== entry.platform.os || configArchitecture !== entry.platform.architecture) {
      throw fail("ghcr_platform_mismatch", {
        image,
        version,
        platform,
        configOs,
        configArchitecture,
      }, "The image config os/architecture must equal the index descriptor.");
    }
    const labels = labelsFromConfig(configJson);
    assertLabel(labels, VERSION_LABEL, version, platform);
    assertLabel(labels, REVISION_LABEL, commit, platform);
    platforms.push({
      os: entry.platform.os,
      architecture: entry.platform.architecture,
      digest: entry.digest,
    });
  }

  return {
    ok: true,
    version,
    commit,
    jsrPackage,
    jsrVersion,
    image,
    indexDigest,
    platforms,
  };
}

export function renderPublishedReleaseCli(result: PublishedReleaseCliResult): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  if (result.status === "verified") {
    return {
      stdout: `${
        JSON.stringify({
          status: "verified",
          version: result.result.version,
          commit: result.result.commit,
          jsrPackage: result.result.jsrPackage,
          jsrVersion: result.result.jsrVersion,
          image: result.result.image,
          indexDigest: result.result.indexDigest,
          platforms: result.result.platforms,
        })
      }\n`,
      stderr: `Published release ${result.result.version} verified.\n`,
      exitCode: 0,
    };
  }
  if (result.status === "waiting_for_sibling") {
    return {
      stdout: `${
        JSON.stringify({
          status: "waiting_for_sibling",
          reason: result.reason,
        })
      }\n`,
      stderr: `Waiting for sibling publication: ${result.reason}\n`,
      exitCode: 0,
    };
  }
  return {
    stdout: `${JSON.stringify({ status: "failed", ...result.error.toJSON() })}\n`,
    stderr: `${result.error.code}\n`,
    exitCode: 1,
  };
}

export function versionFromReleaseTag(tag: string): string {
  if (!RELEASE_TAG.test(tag)) {
    throw fail("invalid_release_identity", { tag }, "Pass the exact vX.Y.Z release tag.");
  }
  return tag.slice(1);
}

async function listWorkflowStatuses(input: {
  repository: string;
  tag: string;
  commit: string;
  token: string;
  fetch?: FetchLike;
  env?: EnvGetter;
}): Promise<{ jsr: PublicationStatus; ghcr: PublicationStatus }> {
  const fetchImpl = input.fetch ?? fetch;
  const envGet = input.env ?? ((name) => Deno.env.get(name));
  const url = `${
    githubApiOrigin(envGet)
  }/repos/${input.repository}/actions/runs?head_sha=${input.commit}&event=push&per_page=100`;
  const payload = await readJson(
    fetchImpl,
    url,
    "sibling_publication_unavailable",
    { repository: input.repository, commit: input.commit },
    githubHeaders(input.token),
  );
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  return publicationStatusesFromWorkflowRuns(runs, input);
}

function latestWorkflowStatus(
  runs: unknown[],
  workflowPath: string,
  input: { repository: string; tag: string; commit: string },
): PublicationStatus {
  const commit = input.commit.toLowerCase();
  const matched = runs.flatMap((run) => {
    const record = asRecord(run);
    if (record === undefined || record.path !== workflowPath) return [];
    const headSha = typeof record.head_sha === "string" ? record.head_sha.toLowerCase() : "";
    const headBranch = typeof record.head_branch === "string" ? record.head_branch : "";
    const event = typeof record.event === "string" ? record.event : "";
    if (headSha !== commit || headBranch !== input.tag || event !== "push") return [];
    const runNumber = typeof record.run_number === "number" ? record.run_number : 0;
    return [{ runNumber, status: mapRunStatus(record.status, record.conclusion) }];
  });
  if (matched.length === 0) return "missing";
  matched.sort((left, right) => right.runNumber - left.runNumber);
  return matched[0].status;
}

function mapRunStatus(status: unknown, conclusion: unknown): PublicationStatus {
  if (
    status === "queued" || status === "requested" || status === "waiting" || status === "pending"
  ) {
    return "queued";
  }
  if (status === "in_progress") return "in_progress";
  if (status === "completed") return mapTriggerConclusion(String(conclusion ?? "failure"));
  return "missing";
}

function mapTriggerConclusion(conclusion: string): PublicationStatus {
  if (conclusion === "success") return "success";
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === "skipped") return "skipped";
  if (conclusion === "in_progress" || conclusion === "queued" || conclusion === "missing") {
    return conclusion;
  }
  return "failure";
}

function classifyPublication(
  status: PublicationStatus,
  label: "JSR" | "GHCR",
): { kind: "ok" } | { kind: "wait"; reason: string } | { kind: "fail"; reason: string } {
  if (status === "success") return { kind: "ok" };
  if (status === "failure" || status === "cancelled" || status === "skipped") {
    return { kind: "fail", reason: `${label} publication did not succeed` };
  }
  return { kind: "wait", reason: `${label} publication has not completed` };
}

function nativePlatformManifests(index: Record<string, unknown>): Array<{
  digest: string;
  platform: { os: string; architecture: string };
}> {
  const manifests = Array.isArray(index.manifests) ? index.manifests : [];
  const native: Array<{ digest: string; platform: { os: string; architecture: string } }> = [];
  const seen = new Set<string>();
  for (const entry of manifests) {
    const record = asRecord(entry);
    if (record === undefined) {
      throw fail(
        "ghcr_malformed_descriptor",
        {},
        "Each index descriptor must be a JSON object.",
      );
    }
    if (isWellFormedAttestation(record)) continue;
    const platform = asRecord(record.platform);
    const os = typeof platform?.os === "string" ? platform.os : "";
    const architecture = typeof platform?.architecture === "string" ? platform.architecture : "";
    const mediaType = typeof record.mediaType === "string" ? record.mediaType : "";
    const digest = typeof record.digest === "string" ? record.digest : "";
    if (
      os.length === 0 || architecture.length === 0 || mediaType.length === 0 ||
      !SHA256_DIGEST.test(digest)
    ) {
      throw fail("ghcr_malformed_descriptor", {
        os,
        architecture,
        mediaType,
        digest,
      }, "Do not skip malformed native descriptors.");
    }
    const key = `${os}/${architecture}`;
    if (!(EXPECTED_NATIVE_PLATFORMS as readonly string[]).includes(key)) {
      throw fail(
        "ghcr_unexpected_native_platform",
        {
          platform: key,
        },
        "Verify every published native platform or reject an index that advertises an unexpected one.",
      );
    }
    if (mediaType !== OCI_MANIFEST_MEDIA_TYPE) {
      throw fail("ghcr_manifest_media_type", {
        platform: key,
        mediaType,
      }, "Each native descriptor must be an OCI image manifest.");
    }
    if (seen.has(key)) {
      throw fail("ghcr_duplicate_native_platform", {
        platform: key,
      }, "The index must not advertise duplicate native platforms.");
    }
    seen.add(key);
    native.push({ digest, platform: { os, architecture } });
  }
  native.sort((left, right) =>
    platformKey(left.platform).localeCompare(platformKey(right.platform))
  );
  return native;
}

function isWellFormedAttestation(record: Record<string, unknown>): boolean {
  const annotations = asRecord(record.annotations) ?? {};
  if (annotations["vnd.docker.reference.type"] !== "attestation-manifest") return false;
  const platform = asRecord(record.platform);
  const os = typeof platform?.os === "string" ? platform.os : "";
  const architecture = typeof platform?.architecture === "string" ? platform.architecture : "";
  const mediaType = typeof record.mediaType === "string" ? record.mediaType : "";
  const digest = typeof record.digest === "string" ? record.digest : "";
  return os === "unknown" && architecture === "unknown" &&
    mediaType === OCI_MANIFEST_MEDIA_TYPE && SHA256_DIGEST.test(digest);
}

function labelsFromConfig(configJson: Record<string, unknown>): Record<string, string> {
  const config = asRecord(configJson.config) ?? {};
  const raw = asRecord(config.Labels) ?? asRecord(config.labels) ?? {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") labels[key] = value;
  }
  return labels;
}

function assertLabel(
  labels: Record<string, string>,
  label: string,
  expected: string,
  platform: string,
): void {
  const actual = labels[label] ?? "";
  if (actual !== expected) {
    throw fail("ghcr_label_mismatch", {
      platform,
      label,
      expected,
      actual,
    }, "Every native platform config must carry the exact release version and commit.");
  }
}

function platformKey(platform: { os: string; architecture: string }): string {
  return `${platform.os}/${platform.architecture}`;
}

async function ghcrToken(
  fetchImpl: FetchLike,
  repository: string,
  envGet: EnvGetter,
): Promise<string> {
  const githubToken = envGet("GH_TOKEN") ?? envGet("GITHUB_TOKEN") ?? "";
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const payload = await readJson(
    fetchImpl,
    `${ghcrOrigin(envGet)}/token?service=ghcr.io&scope=repository:${repository}:pull`,
    "ghcr_token_unavailable",
    { repository },
    headers,
  );
  if (typeof payload.token !== "string" || payload.token.length === 0) {
    throw fail(
      "ghcr_token_unavailable",
      { repository },
      "Authenticate to GHCR before reading the index.",
    );
  }
  return payload.token;
}

async function assertPublishedChecksum(
  bytes: Uint8Array,
  entry: Record<string, unknown>,
  malformedCode: string,
  mismatchCode: string,
  context: PublishedReleaseVerifierContext,
): Promise<void> {
  const size = entry.size;
  const checksum = entry.checksum;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw fail(
      malformedCode,
      { ...context, size: String(size) },
      "JSR manifest size must be an integer byte length.",
    );
  }
  if (typeof checksum !== "string" || !JSR_CHECKSUM.test(checksum)) {
    throw fail(
      malformedCode,
      { ...context, checksum: String(checksum ?? "") },
      "JSR manifest checksum must be sha256-<hex>.",
    );
  }
  if (bytes.byteLength !== size) {
    throw fail(mismatchCode, {
      ...context,
      expectedSize: size,
      actualSize: bytes.byteLength,
    }, "Published file bytes must match the JSR manifest size.");
  }
  const actual = `sha256-${await sha256Bytes(bytes)}`;
  if (actual !== checksum) {
    throw fail(mismatchCode, {
      ...context,
      expected: checksum,
      actual,
    }, "Published file bytes must match the JSR manifest checksum.");
  }
}

function finishCli(
  result: PublishedReleaseCliResult,
  evidencePath: string,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
  evidenceWritten: boolean;
} {
  const rendered = renderPublishedReleaseCli(result);
  if (result.status !== "verified" || evidencePath.length === 0) {
    return { ...rendered, evidenceWritten: false };
  }
  return { ...rendered, evidenceWritten: false };
}

async function readJson(
  fetchImpl: FetchLike,
  url: string,
  code: string,
  context: PublishedReleaseVerifierContext,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const bytes = await readBytes(fetchImpl, url, code, context, headers);
  return parseJsonBytes(bytes, code, context);
}

async function readBytes(
  fetchImpl: FetchLike,
  url: string,
  code: string,
  context: PublishedReleaseVerifierContext,
  headers: Record<string, string> = {},
): Promise<Uint8Array> {
  const response = await request(fetchImpl, url, headers, code, context);
  const bytes = await responseBytes(response);
  if (bytes.byteLength === 0) {
    throw fail(
      code,
      context,
      "Read the published artifact; do not fall back to the source checkout.",
    );
  }
  return bytes;
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  code: string,
  context: PublishedReleaseVerifierContext,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
    });
  } catch (error) {
    throw fail(code, {
      ...context,
      message: error instanceof Error ? error.message : String(error),
    }, "Read the published artifact; do not fall back to the source checkout.");
  }
  if (!response.ok) {
    throw fail(
      code,
      { ...context, status: response.status },
      "Read the published artifact; do not fall back to the source checkout.",
    );
  }
  return response;
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

function parseJsonBytes(
  bytes: Uint8Array,
  code: string,
  context: PublishedReleaseVerifierContext,
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw fail(code, context, "Published metadata must be valid JSON.");
  }
  const record = asRecord(payload);
  if (record === undefined) {
    throw fail(code, context, "Published metadata must be a JSON object.");
  }
  return record;
}

function decodeUtf8(
  bytes: Uint8Array,
  code: string,
  context: PublishedReleaseVerifierContext,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail(code, context, "Published text must be valid UTF-8.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function parseCli(args: readonly string[]): {
  tag: string;
  version: string;
  commit: string;
  coordinate: boolean;
  evidencePath: string;
  image?: string;
} {
  let tag = "";
  let commit = "";
  let coordinate = false;
  let evidencePath = "";
  let image: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--coordinate") {
      coordinate = true;
      continue;
    }
    const value = args[index + 1];
    if (argument === "--tag" && value) {
      tag = value;
      index += 1;
      continue;
    }
    if (argument === "--commit" && value) {
      commit = value;
      index += 1;
      continue;
    }
    if (argument === "--evidence" && value) {
      evidencePath = value;
      index += 1;
      continue;
    }
    if (argument === "--image" && value) {
      if (!/^ghcr\.io\/[a-z0-9][a-z0-9-]*\/mcp-modelica$/.test(value)) {
        throw fail(
          "invalid_release_identity",
          { image: value },
          "Pass an untagged GHCR mcp-modelica image.",
        );
      }
      image = value;
      index += 1;
      continue;
    }
    throw fail(
      "invalid_release_identity",
      { argument },
      "Use --tag vX.Y.Z --commit <sha> [--image ghcr.io/<owner>/mcp-modelica] [--coordinate] [--evidence <path>].",
    );
  }
  const version = versionFromReleaseTag(tag);
  if (!RELEASE_COMMIT.test(commit.toLowerCase())) {
    throw fail("invalid_release_identity", { commit }, "Pass the exact 40-character tag commit.");
  }
  return {
    tag,
    version,
    commit: commit.toLowerCase(),
    coordinate,
    evidencePath,
    ...(image === undefined ? {} : { image }),
  };
}

function requiredEnv(name: string, envGet: EnvGetter): string {
  const value = envGet(name) ?? "";
  if (value.length === 0) {
    throw fail(
      "sibling_publication_unavailable",
      { name },
      "Set the coordinating GitHub Actions environment.",
    );
  }
  return value;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
}

function runRepositoryFullName(record: Record<string, unknown>): string {
  const headRepository = asRecord(record.head_repository);
  if (typeof headRepository?.full_name === "string") return headRepository.full_name;
  const repository = asRecord(record.repository);
  if (typeof repository?.full_name === "string") return repository.full_name;
  return "";
}

function jsrOrigin(envGet: EnvGetter): string {
  return origin(envGet, "JSR_IO_ORIGIN", "https://jsr.io");
}

function ghcrOrigin(envGet: EnvGetter): string {
  return origin(envGet, "GHCR_ORIGIN", "https://ghcr.io");
}

function githubApiOrigin(envGet: EnvGetter): string {
  return origin(envGet, "GITHUB_API_ORIGIN", "https://api.github.com");
}

function origin(envGet: EnvGetter, name: string, fallback: string): string {
  const value = envGet(name) ?? "";
  return value.length > 0 ? value.replace(/\/$/, "") : fallback;
}

async function sha256Digest(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Bytes(bytes)}`;
}

function fail(
  code: string,
  context: PublishedReleaseVerifierContext,
  recovery: string,
): PublishedReleaseVerifierError {
  return new PublishedReleaseVerifierError(code, context, recovery);
}

function containsPhrase(source: string, phrase: string): boolean {
  const pattern = phrase.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(pattern, "i").test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
