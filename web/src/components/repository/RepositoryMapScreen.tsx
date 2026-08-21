import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";

export function RepositoryMapScreen() {
  const { data, isError } = useQuery({ queryKey: ["repo-map"], queryFn: glimmerApi.getRepositoryMap, retry: false });

  if (isError || !data) return <div>Unavailable</div>;

  return (
    <div>
      <h1>Repository Map</h1>
      <ul>
        {data.packages.map((p) => (
          <li key={p.path} className="row">
            {p.name} — {p.frameworks.join(", ") || "Unavailable"}
          </li>
        ))}
      </ul>
    </div>
  );
}
