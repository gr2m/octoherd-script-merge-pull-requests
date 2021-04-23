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
    const query = `query prStatus($htmlUrl: URI!) {
      resource(url: $htmlUrl) {
        ... on PullRequest {
          # merge status
          mergeable
          # review status
          reviewDecision
          viewerCanUpdate
          viewerDidAuthor
          latestOpinionatedReviews(first:10,writersOnly:true) {
            nodes {
              viewerDidAuthor
            }
          }
          # CI status
          commits(last: 1) {
            nodes {
              commit {
                oid
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }
      }
    }
    `;

    const result = await octokit.graphql(query, {
      htmlUrl: pr.html_url,
    });

    const {
      reviewDecision,
      mergeable,
      viewerCanUpdate,
      viewerDidAuthor,
    } = result.resource;
    const combinedStatus =
      result.resource.commits.nodes[0].commit.statusCheckRollup.state;
    const viewerDidApprove = !!result.resource.latestOpinionatedReviews.nodes.find(
      (node) => node.viewerDidAuthor
    );
    const latestCommitId = result.resource.commits.nodes[0].commit.oid;

    const logData = {
      pr: {
        number: pr.number,
        reviewDecision,
        mergeable,
        combinedStatus,
        viewerCanUpdate,
      },
    };

    console.log(`viewerCanUpdate`);
    console.log(viewerCanUpdate);

    if (!viewerCanUpdate) {
      octokit.log.info(
        logData,
        `%s: you cannot update this PR. Skipping`,
        pr.html_url
      );
      continue;
    }

    if (combinedStatus !== "SUCCESS") {
      octokit.log.info(
        logData,
        `%s: status is "%s". Skipping`,
        pr.html_url,
        combinedStatus
      );
      continue;
    }

    if (mergeable !== "MERGEABLE") {
      octokit.log.info(
        logData,
        `%s: mergable status is "%s". Skipping`,
        pr.html_url,
        mergeable
      );
      continue;
    }

    let approved;
    if (reviewDecision !== "APPROVED") {
      if (!viewerDidAuthor && !viewerDidApprove) {
        // attempt to add approval
        await octokit.request(
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          {
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: pr.number,
            event: "APPROVE",
            commit_id: latestCommitId,
          }
        );
        approved = true;

        // check if PR is now approved
        const {
          resource: { reviewDecision: newReviewDecision },
        } = await octokit.graphql(
          `query prStatus($htmlUrl: URI!) {
            resource(url: $htmlUrl) {
              ... on PullRequest {
                reviewDecision
              }
            }
          }`,
          {
            htmlUrl: pr.html_url,
          }
        );

        if (newReviewDecision !== "APPROVED") {
          octokit.log.info(
            logData,
            "%s: awaiting approval. Skipping",
            pr.html_url
          );
          continue;
        }
      } else {
        octokit.log.info(
          logData,
          "%s: awaiting approval. Skipping",
          pr.html_url
        );
        continue;
      }
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
