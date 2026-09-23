// @ts-check
import fs from "node:fs";
import path from "node:path";

/**
 * Resolves a program to an absolute path using only absolute PATH entries. Spawning a bare
 * name lets Windows search the child's cwd first, which is the (untrusted) reviewed repo;
 * relative entries such as "." would do the same on any platform.
 * @param {string} name without extension
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @param {string[]} [extraDirs] absolute fallback directories searched after PATH
 * @returns {string | null}
 */
export function findExecutable(name, env, platform, extraDirs = []) {
  const isWindows = platform === "win32";
  const pathApi = isWindows ? path.win32 : path.posix;
  const file = isWindows ? `${name}.exe` : name;
  const dirs = [...(env.PATH ?? env.Path ?? "").split(isWindows ? ";" : ":"), ...extraDirs].filter((dir) => dir && pathApi.isAbsolute(dir));
  for (const dir of dirs) {
    const candidate = pathApi.join(dir, file);
    try {
      fs.accessSync(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not in this directory
    }
  }
  return null;
}
