import {
  artifactStorageOptionsFromEnv,
  copyLocalArtifacts,
  ReplicatedAgentHomeStore,
  SupabaseArtifactStore,
} from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

// Copies files and computer homes saved on the local volume to the configured object storage, so
// the service no longer depends on one container's disk. Run inside the deployed container after
// ARTIFACT_STORAGE_* is set; reads keep falling back to the volume until this has finished.
loadRootEnv();

const options = artifactStorageOptionsFromEnv(process.env);
if (!options)
  throw new Error(
    "ARTIFACT_STORAGE_URL, ARTIFACT_STORAGE_KEY and ARTIFACT_STORAGE_BUCKET are required",
  );
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const dataDir = process.env.DATA_DIR ?? "./data";
const remote = new SupabaseArtifactStore(options);
const result = await copyLocalArtifacts(dataDir, remote, controller.signal);
process.stdout.write(`copied ${result.copied} files (${result.bytes} bytes)\n`);
const homes = await new ReplicatedAgentHomeStore(dataDir, remote).publishLocalHomes(
  controller.signal,
);
process.stdout.write(`published ${homes} computer homes\n`);
