import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * `standalone` so this can be a container.
   *
   * Next's default build expects `next start` with the whole node_modules tree
   * present - around 300 packages here, most of them build-time only.
   * Standalone emits a self-contained server carrying just what the running app
   * imports, which is the difference between a deployable image and a
   * development checkout copied onto a host.
   *
   * `pg` is the dependency that matters at runtime and it traces correctly,
   * because lib/db.ts imports it statically. A future dependency loaded by
   * string at runtime would need `outputFileTracingIncludes`, and the symptom
   * would be a MODULE_NOT_FOUND inside the container that does not reproduce
   * locally - worth knowing before spending an afternoon on it.
   */
  output: "standalone",
};

export default nextConfig;
