import * as core from "@actions/core";
import * as github from "@actions/github";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

let repoShas: string[] | undefined;

const verifyCommit = async (sha: string): Promise<boolean> => {
  if (!repoShas) {
    try {
      const cmd = `git log --format=format:%H`;
      core.info(`Getting list of SHAs in repo via command "${cmd}"`);

      const { stdout } = await execAsync(cmd);

      repoShas = stdout.trim().split("\n");
    } catch (e: any) {
      repoShas = [];
      core.warning(`Error while attempting to get list of SHAs: ${e?.message}`);

      return false;
    }
  }

  core.info(`Looking for SHA ${sha} in repo SHAs`);

  return repoShas.includes(sha);
};

async function run(): Promise<void> {
  try {
    const inputs = {
      token: core.getInput("token"),
      branch: core.getInput("branch"),
      workflow: core.getInput("workflow"),
      job: core.getInput("job"),
      verify: core.getInput("verify") === "true" ? true : false,
      repo: core.getInput("repo"),
    };

    const octokit = github.getOctokit(inputs.token);
    const repository: string = inputs.repo;
    const [owner, repo] = repository.split("/");

    const workflows = await octokit.rest.actions.listRepoWorkflows({
      owner,
      repo,
    });
    const workflowId = workflows.data.workflows.find(
      (w: any) => w.name.toLowerCase() === inputs.workflow.toLowerCase()
    )?.id;

    if (!workflowId) {
      core.setFailed(`No workflow exists with the name "${inputs.workflow}"`);
      return;
    } else {
      core.info(`Discovered workflowId for search: ${workflowId}`);
    }

    const response = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowId,
      per_page: 100,
    });
    const runs = response.data.workflow_runs
      .filter(
        (x) =>
          (!inputs.branch || x.head_branch === inputs.branch) &&
          (inputs.job || x.conclusion === "success")
      )
      .sort(
        (r1, r2) =>
          new Date(r2.created_at).getTime() - new Date(r1.created_at).getTime()
      );

    let lastSha: string | undefined = undefined;
    let sha: string | undefined = undefined;

    core.debug(`Found ${runs.length} runs`);
    if (runs.length > 0) {
      for (const run of runs) {
        lastSha = run.head_sha;
        core.debug(`Run SHA: ${run.head_sha}`);
        core.debug(`Run Branch: ${run.head_branch}`);
        core.debug(`Wanted branch: ${inputs.branch}`);

        if (inputs.branch && run.head_branch !== inputs.branch) {
          continue;
        }

        if (inputs.verify && !(await verifyCommit(run.head_sha))) {
          core.warning(`Failed to verify commit ${run.head_sha}. Skipping.`);
          continue;
        }

        if (inputs.job) {
          const jobs = await octokit.rest.actions.listJobsForWorkflowRun({
            owner,
            repo,
            run_id: run.id,
          });

          let foundJob = false;
          for (const job of jobs.data.jobs) {
            core.debug(`Checking job: ${job}`);
            if (job.name === inputs.job) {
              if (job.conclusion === "success") {
                foundJob = true;
                break;
              }
            }
          }
          if (!foundJob) {
            continue;
          }
        }

        core.info(
          inputs.verify
            ? `Commit ${run.head_sha} from run ${run.html_url} verified as last successful CI run.`
            : `Using ${run.head_sha} from run ${run.html_url} as last successful CI run.`
        );
        sha = run.head_sha;

        break;
      }
    } else {
      core.info(`No previous runs found for branch ${inputs.branch}.`);
    }

    if (!sha) {
      core.warning(
        `Unable to determine SHA of last successful commit (possibly outside the window of ${runs.length} runs). Using earliest SHA available.`
      );
      sha = lastSha;
    }

    core.setOutput("sha", sha);
  } catch (error: any) {
    core.setFailed(error?.message);
  }
}

run();
