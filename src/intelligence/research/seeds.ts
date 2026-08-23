/**
 * WHERE SERVA IS PERMITTED TO LOOK.
 *
 * SPEC: §48, 21.
 *
 * A deployment policy, not a department's choice. The department that raises a research
 * question knows what it needs to find out; it has no authority to decide which hosts the
 * company may reach, and an asking department that could name its own allowed hosts would
 * be choosing its own network boundary.
 *
 * Empty by default, and deliberately so. With no permitted host, research is UNAVAILABLE
 * and a competitive gate is NOT_VERIFIED — which is the honest state of an offline
 * installation, and must never quietly become "we found no competitors".
 *
 * Lives here rather than in the research department because the RUNNER now needs it too:
 * an obligation recorded with no permitted host is one nobody can ever fulfil, and saying
 * so at the point it is raised is better than discovering it at retrieval.
 */
export interface ResearchSeeds {
  readonly hosts: readonly string[];
  readonly urls: readonly string[];
}

let SEEDS: ResearchSeeds = { hosts: [], urls: [] };

export function configureResearchSeeds(seeds: ResearchSeeds): void {
  SEEDS = seeds;
}

export function researchSeeds(): ResearchSeeds {
  return SEEDS;
}
