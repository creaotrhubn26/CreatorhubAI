import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { absolutePath, fileHref } from "../../state/fileLink";

export function RepositoryMapScreen() {
  const { data, isError } = useQuery({ queryKey: ["repo-map"], queryFn: glimmerApi.getRepositoryMap, retry: false });

  if (isError || !data) return <div>Unavailable</div>;

  return (
    <div>
      <h1>Repository Map</h1>
      <ul>
        {data.packages.map((p) => (
          <li key={p.path} className="row">
            {/* Task A4: opens the package's own manifest — `p.path` is the
                real file the map was built from (p.dir is its directory, and
                a directory is not something a file viewer can honestly show). */}
            <Link to={fileHref(absolutePath(data.workspace, p.path))}>{p.name}</Link>
            {" — "}
            {p.frameworks.join(", ") || "Unavailable"}
          </li>
        ))}
      </ul>
    </div>
  );
}
