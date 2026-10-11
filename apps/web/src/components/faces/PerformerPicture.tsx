"use client";

import { Box } from "@mantine/core";

/**
 * A performer's picture, small, beside a face that may be them (§6 "A tag's picture"): who the
 * face is being compared with, at a glance. A portrait's shape; the place held empty where they
 * have none yet.
 */
export const PerformerPicture: React.FC<{ url: string | null; width: number }> = ({
    url,
    width,
}) =>
    url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a small tag picture
        <img
            src={url}
            alt=""
            width={width}
            height={Math.round((width * 5) / 4)}
            loading="lazy"
            decoding="async"
            style={{ objectFit: "cover", borderRadius: 4, flex: "0 0 auto", display: "block" }}
        />
    ) : (
        <Box
            w={width}
            h={Math.round((width * 5) / 4)}
            style={{ flex: "0 0 auto", borderRadius: 4, background: "var(--ps-well)" }}
        />
    );
