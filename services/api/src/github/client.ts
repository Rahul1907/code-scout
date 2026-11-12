export interface GitHubRepoSummary {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  sizeKb: number;
  description: string;
  language: string | null;
  htmlUrl: string;
  updatedAt: string;
}

interface RawGitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  size: number;
  description: string | null;
  language: string | null;
  html_url: string;
  updated_at: string;
}

function mapRepo(raw: RawGitHubRepo): GitHubRepoSummary {
  return {
    id: raw.id,
    name: raw.name,
    fullName: raw.full_name,
    owner: raw.owner.login,
    private: raw.private,
    defaultBranch: raw.default_branch,
    sizeKb: raw.size,
    description: raw.description ?? "",
    language: raw.language,
    htmlUrl: raw.html_url,
    updatedAt: raw.updated_at,
  };
}

export async function listUserGitHubRepos(
  accessToken: string,
  page: number,
  perPage: number,
): Promise<{ repos: GitHubRepoSummary[]; hasMore: boolean }> {
  const url = new URL("https://api.github.com/user/repos");
  url.searchParams.set("visibility", "public");
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "CodeScout",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error (${res.status}) listing repositories`);
  }

  const data = (await res.json()) as RawGitHubRepo[];
  const linkHeader = res.headers.get("link") ?? "";
  const hasMore = linkHeader.includes('rel="next"') || data.length === perPage;

  return {
    repos: data.map(mapRepo),
    hasMore,
  };
}

export async function getGitHubRepo(
  fullName: string,
  accessToken?: string,
): Promise<GitHubRepoSummary | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "CodeScout",
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`GitHub API error (${res.status}) fetching ${fullName}`);
  }
  const raw = (await res.json()) as RawGitHubRepo;
  return mapRepo(raw);
}

