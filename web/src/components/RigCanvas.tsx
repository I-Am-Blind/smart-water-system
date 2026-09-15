"use client";
import { useRef } from "react";
import { ScanIcon } from "lucide-react";
import { Twin, type TwinHandle } from "@/components/twin";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Client-only: the 3D canvas plus its reset control. Fills its parent. */
export default function RigCanvas() {
  const twin = useRef<TwinHandle>(null);
  return (
    <div className="absolute inset-0">
      <Twin ref={twin} view="topside" />
      <div className="absolute right-2 top-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon" aria-label="Reset view" onClick={() => twin.current?.resetView()}>
                <ScanIcon />
              </Button>
            }
          />
          <TooltipContent>Reset view</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
