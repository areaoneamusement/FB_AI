import type { OutputPort, Repository } from "../adapters/ports.js";
import {
  CopyReadyExporter,
  type CopyReadyExporterOptions,
} from "./copy-ready-exporter.js";

/** Phase 1 composition seam: all output is manual copy-ready export. */
export function createPhase1OutputPort(
  repository: Repository,
  options: CopyReadyExporterOptions = {},
): OutputPort {
  return new CopyReadyExporter(repository, options);
}

export { CopyReadyExporter } from "./copy-ready-exporter.js";
export type { CopyReadyExporterOptions } from "./copy-ready-exporter.js";
