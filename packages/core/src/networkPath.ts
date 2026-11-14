import { z } from "zod";

/**
 * Where an editing machine finds a library's files (§14d "Editor export").
 *
 * `MediaRoot.path` is the container's view (`/media/videos`), which means nothing to the PC
 * running Resolve. A library's network path is the same folder as Windows sees it: a UNC share
 * (`\\NAS\Multimedia\Videos`) or a mapped drive (`Z:\Videos`). The app never reads through it --
 * it is only written into exported timelines -- so it is checked for shape, never for existence.
 */

const UNC = /^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+(\\.*)?$/;
const DRIVE = /^[A-Za-z]:\\/;

/** Accepts forward slashes as typed, stores backslashes, and drops a trailing separator. */
export const networkPathSchema = z
    .string()
    .trim()
    .max(1024)
    .transform((value) => value.replace(/\//g, "\\").replace(/\\+$/, ""))
    // eslint-disable-next-line no-control-regex -- matching them is the point
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "No control characters")
    .refine(
        (value) => UNC.test(value) || DRIVE.test(`${value}\\`),
        "A Windows network path, like \\\\NAS\\Multimedia or Z:\\Videos"
    );

/**
 * A file's path on the editing machine: the library's network path plus its relative path.
 *
 * The relative path is the database's (forward slashes); the caller has already been through
 * `assertSafeRelativePath`, so there is no `..` here to climb out of the share with.
 */
export const joinNetworkPath = (networkPath: string, relPath: string): string =>
    `${networkPath}\\${relPath.split("/").join("\\")}`;

/**
 * A Windows path as a `file:` URL, the form an FCPXML `media-rep` takes.
 *
 * `\\host\share\a b.mp4` is `file://host/share/a%20b.mp4` -- the host goes in the authority --
 * and `Z:\a b.mp4` is `file:///Z:/a%20b.mp4`. Each segment is percent-encoded on its own so a
 * `#` or `%` in a file name cannot be read as URL syntax.
 */
export const windowsFileUrl = (windowsPath: string): string => {
    const parts = windowsPath.replace(/\//g, "\\").split("\\");

    if (windowsPath.startsWith("\\\\") || windowsPath.startsWith("//")) {
        const [host, ...rest] = parts.slice(2);

        return `file://${host}/${rest.map(encodeURIComponent).join("/")}`;
    }

    const [drive, ...rest] = parts;

    return `file:///${drive}/${rest.map(encodeURIComponent).join("/")}`;
};
