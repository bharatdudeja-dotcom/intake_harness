import { getSettings, programmeLabel } from "@/lib/settings";
import { ProgrammesBrowser } from "./programmes-browser";

export const dynamic = "force-dynamic";

export default async function ProgrammesPage() {
  const settings = await getSettings();
  return <ProgrammesBrowser label={programmeLabel(settings)} />;
}
