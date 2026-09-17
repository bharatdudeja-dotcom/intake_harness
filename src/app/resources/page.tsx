import { getSettings } from "@/lib/settings";
import { ResourcesBrowser } from "./resources-browser";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const settings = await getSettings();
  return <ResourcesBrowser kindLabels={settings.kind_labels} />;
}
