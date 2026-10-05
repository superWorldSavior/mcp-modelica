import { assert, assertEquals, assertMatch } from "@std/assert";
import { PACKAGE_VERSION, QUALIFIED_CONTAINER_DENO_VERSION } from "../src/release-identity.ts";

const DENO_2_9_6_INDEX_DIGEST =
  "sha256:4cf0029b9aeeeed5efcbb71828737f0d7c8c8a20072df960e51a5679ef0d21ba";
const DENO_2_9_6_AMD64_DIGEST =
  "sha256:456e1a0fada18d727c3f38eb4937218c1b46924c832b713dcf9358eb32ff15a6";
const DENO_2_9_6_ARM64_DIGEST =
  "sha256:3257165d117f787441e08ad0981f916969423220bdb4550c9fcdecc21ab6551f";

Deno.test("Docker release inputs are immutable and verified", async () => {
  const packageVersion = (JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { version: string }).version;
  assertEquals(PACKAGE_VERSION, packageVersion);
  assertEquals(QUALIFIED_CONTAINER_DENO_VERSION, "2.9.6");
  const citation = await Deno.readTextFile(new URL("../CITATION.cff", import.meta.url));
  const gitignore = await Deno.readTextFile(new URL("../.gitignore", import.meta.url));
  const server = await Deno.readTextFile(new URL("../server.ts", import.meta.url));
  const developmentGuide = await Deno.readTextFile(
    new URL("../docs/development-and-release.md", import.meta.url),
  );
  assertMatch(citation, new RegExp(`^version: ${packageVersion.replace(".", "\\.")}$`, "m"));
  assert(
    gitignore.split(/\r?\n/).includes(".deps/"),
    "The CI-only audited MCP View checkout must not dirty tag publication worktrees.",
  );
  assert(
    server.includes("version: PACKAGE_VERSION") &&
      server.includes("instructions: runtimeIdentityInstructions()"),
    "Discovery must distinguish the package release identity from the actual Deno runtime identity.",
  );
  assert(
    developmentGuide.includes(
      "For local development, install Deno 2.9.6, OpenModelica 1.27.0, and MSL 4.1.0",
    ),
    "Local development documentation must name the exact qualified Deno runtime release.",
  );
  const dockerfile = await Deno.readTextFile(new URL("../Dockerfile", import.meta.url));
  const omcIntegration = await Deno.readTextFile(
    new URL("./omc_integration_test.ts", import.meta.url),
  );
  const checkWorkflow = await Deno.readTextFile(
    new URL("../.github/workflows/check.yml", import.meta.url),
  );
  const publishWorkflow = await Deno.readTextFile(
    new URL("../.github/workflows/publish-image.yml", import.meta.url),
  );
  const publishJsrWorkflow = await Deno.readTextFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
  );

  assertMatch(
    dockerfile,
    /^FROM openmodelica\/openmodelica@sha256:[a-f0-9]{64} AS runtime$/m,
  );
  assertMatch(
    dockerfile,
    new RegExp(
      `COPY --from=denoland/deno@${DENO_2_9_6_INDEX_DIGEST} /deno /usr/local/bin/deno`,
    ),
  );
  assert(
    dockerfile.includes(`Deno 2.9.6 OCI index: ${DENO_2_9_6_INDEX_DIGEST}`) &&
      dockerfile.includes(`linux/amd64: ${DENO_2_9_6_AMD64_DIGEST}`) &&
      dockerfile.includes(`linux/arm64: ${DENO_2_9_6_ARM64_DIGEST}`) &&
      dockerfile.includes("assertQualifiedContainerDenoRuntime()"),
    "The exact multi-architecture Deno source and its actual runtime assertion must be release inputs.",
  );
  assert(
    dockerfile.includes("RUN deno cache --frozen server.ts"),
    "Each native image build must populate its own Deno cache.",
  );
  assertMatch(dockerfile, /^ARG MSL_TARBALL_SHA256=[a-f0-9]{64}$/m);
  assert(
    dockerfile.includes("sha256sum -c -"),
    "The downloaded MSL archive must be verified before extraction.",
  );
  assert(
    /^ARG PERL_VERSION=5\.34\.0-3ubuntu1\.7$/m.test(dockerfile) &&
      dockerfile.includes('"perl=${PERL_VERSION}"'),
    "The OS-lock helper version must be installed explicitly in the pinned runtime image.",
  );
  assert(
    dockerfile.includes('"--allow-run=omc,perl"'),
    "The production entrypoint must explicitly permit both OMC and the OS-lock helper.",
  );
  assert(
    dockerfile.includes(
      "deno test --allow-read --allow-write --allow-run=perl --allow-env tests/resumable_service_test.ts",
    ),
    "The release verification stage must execute the real 2.1 OS-lock/capacity smoke.",
  );
  assert(
    dockerfile.includes(
      "--allow-env=MODELICA_RUN_DIR,MCP_AUTH_PROVIDER,MCP_AUTH_AUDIENCE,MCP_AUTH_RESOURCE,MCP_AUTH_DOMAIN,MCP_AUTH_ISSUER,MCP_AUTH_JWKS_URI,MCP_AUTH_SCOPES,MCP_AUTH_RESOURCE_METADATA_URL",
    ),
    "The HTTP entrypoint must be permitted to read the full optional MCP auth configuration.",
  );
  assert(
    dockerfile.includes(
      "FROM runtime AS verify\n" +
        "ARG OMC_INTEGRATION_TIMEOUT_MS=30000\n" +
        "COPY tests ./tests\n" +
        "COPY scripts ./scripts\n" +
        "RUN deno task model-schema:check\n" +
        "RUN deno test --allow-read --allow-write --allow-run=perl --allow-env tests/resumable_service_test.ts\n" +
        'RUN RUN_OMC_INTEGRATION=1 OMC_INTEGRATION_TIMEOUT_MS="${OMC_INTEGRATION_TIMEOUT_MS}" deno task test:omc',
    ),
    "The release image must verify compiler-derived parameter metadata before the simulation proof.",
  );
  assert(
    omcIntegration.includes(
      "2.1 resumable submit runs both qualified kits through real OpenModelica",
    ) && omcIntegration.includes("new ResumableSimulationService(") &&
      omcIntegration.includes('model_id: "coffee-machine-v1"') &&
      omcIntegration.includes('model_id: "linear-thermal-ramp-v1"'),
    "The Docker OMC gate must execute the real 2.1 provider for both qualified kits.",
  );
  assert(
    dockerfile.includes(
      "RUN mkdir -p /verification && uname -m > /verification/native-omc-smoke-passed",
    ) &&
      dockerfile.includes("COPY --from=verify /verification/native-omc-smoke-passed") &&
      !dockerfile.includes("BUILDPLATFORM") && !dockerfile.includes("TARGETPLATFORM") &&
      !dockerfile.includes("DENO_DIR"),
    "The final image must retain native-runner evidence without platform-crossing Deno state.",
  );
  assert(
    checkWorkflow.includes("runs-on: ubuntu-24.04") &&
      checkWorkflow.includes("runs-on: ubuntu-24.04-arm") &&
      checkWorkflow.includes("deno-version: v2.9.6") &&
      checkWorkflow.includes("2.9.6") &&
      checkWorkflow.includes('test "$(uname -m)" = x86_64') &&
      checkWorkflow.includes('test "$(uname -m)" = aarch64') &&
      !checkWorkflow.includes("setup-qemu-action") && !checkWorkflow.includes("buildx build"),
    "CI must build and smoke the final image on distinct native AMD64 and ARM64 runners.",
  );
  assert(
    publishWorkflow.includes('tags: ["v*"]') &&
      publishWorkflow.includes("deno-version: v2.9.6") &&
      publishWorkflow.includes("io.casys.mcp-modelica.deno-version=2.9.6") &&
      !publishWorkflow.includes("workflow_dispatch") &&
      publishWorkflow.includes("needs: release-gate") &&
      publishWorkflow.includes("deno publish --dry-run") &&
      publishWorkflow.includes("Build and smoke the native AMD64 final image") &&
      publishWorkflow.includes("docker build --target final --tag mcp-modelica:release-check .") &&
      publishWorkflow.includes("bash scripts/smoke-container-http.sh mcp-modelica:release-check") &&
      publishWorkflow.includes(
        "docker/github-builder/.github/workflows/build.yml@a492c6d04fd3315f67230809b44d60cc0acd50b3",
      ) &&
      publishWorkflow.includes("platforms: linux/amd64,linux/arm64") &&
      publishWorkflow.includes("setup-qemu: false") && publishWorkflow.includes("target: final") &&
      publishWorkflow.includes('sign: "true"') &&
      publishWorkflow.includes("type=match,pattern=v(.*),group=1") &&
      publishWorkflow.includes("type=sha,format=long,prefix=sha-") &&
      publishWorkflow.includes("registry: ghcr.io") &&
      publishWorkflow.includes("packages: write") && publishWorkflow.includes("id-token: write"),
    "Tag releases must gate the JSR archive and distribute signed native multi-architecture GHCR images.",
  );
  assert(
    publishJsrWorkflow.includes("deno-version: v2.9.6") &&
      publishJsrWorkflow.includes("smoke-container-http.sh") &&
      publishJsrWorkflow.includes("2.9.6"),
    "The JSR release gate must use and verify the same qualified Deno runtime identity.",
  );
  const readme = await Deno.readTextFile(new URL("../README.md", import.meta.url));
  const verifyPublishedWorkflow = await Deno.readTextFile(
    new URL("../.github/workflows/verify-published.yml", import.meta.url),
  );
  assert(
    !readme.includes("forthcoming") &&
      !/@sha256:[a-f0-9]{64}/.test(readme) &&
      readme.includes(
        "ghcr.io/superworldsavior/mcp-modelica@${MODELICA_IMAGE_DIGEST:?set from verified evidence}",
      ) &&
      readme.includes(`ghcr.io/superworldsavior/mcp-modelica:${packageVersion}`) &&
      readme.includes(`jsr:@casys/mcp-modelica@${packageVersion}`) &&
      /After the paired GHCR image\s+publication has succeeded/.test(readme) &&
      /immutable GHCR index\s+digest/.test(readme),
    "The packaged README must deploy a verified digest variable, not a mutable tag or historical pin.",
  );
  assert(
    !publishWorkflow.includes("Published release") &&
      !publishJsrWorkflow.includes("Published release") &&
      verifyPublishedWorkflow.includes(
        "workflows:\n      - Publish JSR\n      - Publish container image",
      ) &&
      verifyPublishedWorkflow.includes("types:\n      - completed") &&
      verifyPublishedWorkflow.includes(
        "github.event.workflow_run.head_repository.full_name == github.repository",
      ) &&
      verifyPublishedWorkflow.includes("github.event.workflow_run.event == 'push'") &&
      verifyPublishedWorkflow.includes("github.event.workflow_run.conclusion == 'success'") &&
      verifyPublishedWorkflow.includes(".github/workflows/publish.yml") &&
      verifyPublishedWorkflow.includes(".github/workflows/publish-image.yml") &&
      verifyPublishedWorkflow.includes("git/ref/tags/") &&
      verifyPublishedWorkflow.includes("git/tags/") &&
      verifyPublishedWorkflow.includes("persist-credentials: false") &&
      verifyPublishedWorkflow.includes("ref: ${{ steps.release.outputs.commit }}") &&
      verifyPublishedWorkflow.includes("scripts/verify-published-release.ts") &&
      verifyPublishedWorkflow.includes("--coordinate") &&
      verifyPublishedWorkflow.includes("--evidence verification/published-release.json") &&
      verifyPublishedWorkflow.includes(
        "deno run --allow-net --allow-env --allow-read --allow-write=verification",
      ) &&
      !verifyPublishedWorkflow.includes("deno task verify:published") &&
      verifyPublishedWorkflow.includes("hashFiles('verification/published-release.json')") &&
      verifyPublishedWorkflow.includes(
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      ) &&
      verifyPublishedWorkflow.includes("contents: read") &&
      !verifyPublishedWorkflow.includes("contents: write") &&
      !verifyPublishedWorkflow.includes("workflow_dispatch") &&
      verifyPublishedWorkflow.includes("deno-version: v2.9.6"),
    "The post-publication verifier must authenticate the tag commit before checkout and archive evidence only after full success.",
  );
  assert(
    developmentGuide.includes("post-publication verifier") &&
      developmentGuide.includes("published `deno.json`") &&
      developmentGuide.includes("annotated tag peel") &&
      developmentGuide.includes("MODELICA_IMAGE_DIGEST") &&
      /never announced\s+as verified/.test(developmentGuide) &&
      !developmentGuide.includes("A later documentation-only commit may pin that digest on `main`"),
    "Release documentation must sequence published-artifact proof after both registries succeed.",
  );
});
