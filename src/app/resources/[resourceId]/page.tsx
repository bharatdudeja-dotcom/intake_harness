import { ResourcesBrowser } from "../resources-browser";

export default async function ResourceDetailPage({ params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = await params;
  return <ResourcesBrowser initialResourceId={resourceId} />;
}
