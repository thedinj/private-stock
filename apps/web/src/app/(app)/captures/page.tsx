"use client";

import { Suspense } from "react";

import { CapturesBrowser } from "@/components/captures/CapturesBrowser";
import { useReturnCorrection } from "@/lib/useReturnCorrection";

/**
 * Your captures (§9 "Your captures, in one place").
 *
 * The browser reads its view from the address, and a static route that calls
 * `useSearchParams` needs a Suspense boundary or the build refuses to prerender it.
 */
const CapturesPage: React.FC = () => {
    useReturnCorrection();

    return (
        <Suspense fallback={null}>
            <CapturesBrowser />
        </Suspense>
    );
};

export default CapturesPage;
