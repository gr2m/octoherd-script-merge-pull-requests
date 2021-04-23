// @ts-check

/**
 * Merge a bunch of pull requests based on parameters
 *
 * @param {import('@octoherd/cli').Octokit} octokit
 * @param {import('@octoherd/cli').Repository} repository
 * @param {object} options
 * @param {string} [options.author] GitHub username to filter the pull requests by
 */
export async function script(octokit, repository, { author }) {
  let pullRequests = await octokit.paginate("GET /repos/{owner}/{repo}/pulls", {
    owner: repository.owner.login,
    repo: repository.name,
    state: "open",
  });

  if (author) {
    pullRequests = pullRequests.filter((pr) => pr.user.login === author);
  }

  for (const pr of pullRequests) {
    const query = `query($htmlUrl: URI!) {
      resource(url: $htmlUrl) {
        ... on PullRequest {
          state
          author {
            login
          }
          files(first:2) {
            nodes {
              path
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                oid
                checkSuites(first: 100) {
                  nodes {
                    checkRuns(first: 100) {
                      nodes {
                        name
                        conclusion
                        permalink
                      }
                    }
                  }
                }
                status {
                  state
                  contexts {
                    state
                    targetUrl
                    description
                    context
                  }
                }
              }
            }
          }
        }
      }
    }`;

    const result = await octokit.graphql(query, {
      htmlUrl: pr.html_url,
    });

    const [{ commit: lastCommit }] = result.resource.commits.nodes;
    const checkRuns = [].concat(
      ...lastCommit.checkSuites.nodes.map((node) => node.checkRuns.nodes)
    );
    const statuses = lastCommit.status ? lastCommit.status.contexts : [];

    const unsuccessfulCheckRuns = checkRuns
      .filter(
        (checkRun) =>
          checkRun.conclusion !== "SUCCESS" && checkRun.conclusion !== "NEUTRAL"
      )
      .filter((checkRun) => {
        return checkRun.conclusion !== null;
      });
    const unsuccessStatuses = statuses.filter(
      (status) => status.state !== "SUCCESS"
    );

    if (unsuccessfulCheckRuns.length || unsuccessStatuses.length) {
      octokit.log.info(
        `${
          unsuccessfulCheckRuns.length + unsuccessStatuses.length
        } checks/statuses out of ${
          checkRuns.length + statuses.length
        } are not successful:`
      );

      for (const checkRun of unsuccessfulCheckRuns) {
        octokit.log.info(`- Check run by "${checkRun.name}"
              Conclusion: ${checkRun.conclusion}
              ${checkRun.permalink}`);
      }

      for (const status of unsuccessStatuses) {
        octokit.log.info(`- Status run by "${status.context}"
              state: ${status.state}
              ${status.targetUrl}`);
      }

      continue;
    }

    await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: pr.number,
        commit_title: pr.title,
        merge_method: "squash",
      }
    );
    octokit.log.info("pull request merged: %s", pr.html_url);
  }
}
