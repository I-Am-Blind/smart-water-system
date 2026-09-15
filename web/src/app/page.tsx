import { AppHeader } from "@/components/AppHeader";
import { BranchesCard } from "@/components/BranchesCard";
import { EventsCard } from "@/components/EventsCard";
import { FlowCard } from "@/components/FlowCard";
import { RigCard } from "@/components/RigCard";
import { SectionCards } from "@/components/SectionCards";

/**
 * One scrolling page. Server component: pure layout; every live piece is a client component with its
 * own selector. On lg the right column (branches + events) fills the height of the rig card and the
 * flow chart spans the full width below; smaller screens stack cards, rig, branches, flow, events.
 */
export default function Page() {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
        <SectionCards />
        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
          <RigCard className="order-1 lg:col-span-2" />
          <div className="contents lg:order-2 lg:flex lg:min-h-0 lg:flex-col lg:gap-6">
            <BranchesCard className="order-2 lg:shrink-0" />
            <EventsCard className="order-4 lg:min-h-0 lg:flex-1" />
          </div>
          <FlowCard className="order-3 lg:order-3 lg:col-span-3" />
        </div>
      </main>
    </div>
  );
}
