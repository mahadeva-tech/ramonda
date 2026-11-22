/**
 * Every GraphQL document `Github` sends, in one place.
 *
 * The owner-scoped ones all go through `repositoryOwner`, which resolves a login
 * to whichever of User/Organization holds it — Github gives the two a single
 * namespace, so the login alone is unambiguous and the caller never has to say
 * which kind it is. Both implement `ProjectV2Owner`, so one query serves user-
 * and org-owned projects alike.
 */

/** Field ids and status option ids: what a run needs to write to the project. */
export const PROJECT_META_QUERY = /* GraphQL */ `
  query ($login: String!, $number: Int!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          id
          public
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * What is read about an issue blocking another: enough for `decideStart` to
 * settle, without a call of its own, whether the issue it blocks can start.
 *
 * The status comes back for every project the issue is on, because an issue's
 * items cannot be narrowed to one project in the query — the caller keeps the
 * one on its own board. Every document spreading this declares `$statusField`.
 */
const BLOCKER_FIELDS = /* GraphQL */ `
  fragment BlockerFields on Issue {
    number
    title
    state
    stateReason
    repository {
      nameWithOwner
    }
    projectItems(first: 20) {
      nodes {
        id
        project {
          id
        }
        fieldValueByName(name: $statusField) {
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
          }
        }
      }
    }
  }
`;

/**
 * Project items matching a filter, narrowed to the issues ramonda can pick up,
 * each with the issues blocking it.
 *
 * Two blockers rather than all of them: a task may have one, so two is what
 * tells "one" from "too many", and `totalCount` says how many there really are.
 */
export const PROJECT_ITEMS_QUERY = /* GraphQL */ `
  query ($login: String!, $number: Int!, $q: String!, $first: Int!, $statusField: String!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          items(first: $first, query: $q) {
            nodes {
              id
              content {
                __typename
                ... on Issue {
                  number
                  title
                  body
                  blockedBy(first: 2) {
                    totalCount
                    nodes {
                      ...BlockerFields
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  ${BLOCKER_FIELDS}
`;

/**
 * One issue, read while following a dependency chain back from a task that
 * waits on it: what it is blocked by in turn, and whether it is a task ramonda
 * could work itself.
 */
export const CHAIN_ISSUE_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $number: Int!, $statusField: String!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        ...BlockerFields
        body
        labels(first: 100) {
          nodes {
            name
          }
        }
        blockedBy(first: 2) {
          totalCount
          nodes {
            ...BlockerFields
          }
        }
      }
    }
  }
  ${BLOCKER_FIELDS}
`;

/**
 * The repo's open pull requests, which is where a blocker's branch is found.
 *
 * Not through the blocker's own linked pull requests: Github links a `Closes #N`
 * only on a PR targeting the default branch, so a PR stacked on another task's
 * branch is linked to nothing — and the chain would break at its second link.
 */
export const OPEN_PULL_REQUESTS_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 100) {
        nodes {
          url
          headRefName
          headRepository {
            nameWithOwner
          }
        }
      }
    }
  }
`;

/**
 * The same project as `PROJECT_META_QUERY`, read for `setup-project` rather than
 * for a run: identity plus every field with its options *and their colors*, which
 * is what an option append has to send back unchanged.
 *
 * The workflows come along because some of Github's built-in ones fight ramonda
 * and the people on the board for the `Status` field — see
 * `CONFLICTING_WORKFLOWS` — and the plan has to know which of them this project
 * carries before it decides anything. Read here rather
 * than in a query of its own so the whole diff is still built from one answer.
 */
export const PROJECT_SHAPE_QUERY = /* GraphQL */ `
  query ($login: String!, $number: Int!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          id
          number
          title
          url
          public
          workflows(first: 50) {
            nodes {
              id
              name
            }
          }
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                  color
                  description
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const OWNER_ID_QUERY = /* GraphQL */ `
  query ($login: String!) {
    repositoryOwner(login: $login) {
      id
    }
  }
`;

export const REPOSITORY_ID_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
    }
  }
`;

/**
 * `createProjectV2` takes no visibility argument, so `public` is read back rather
 * than set: a new project is private by default, and asking confirms that rather
 * than trusting it. `SET_PROJECT_PRIVATE_MUTATION` fixes the one case where it
 * is not.
 */
export const CREATE_PROJECT_MUTATION = /* GraphQL */ `
  mutation ($ownerId: ID!, $title: String!, $repositoryId: ID) {
    createProjectV2(input: { ownerId: $ownerId, title: $title, repositoryId: $repositoryId }) {
      projectV2 {
        id
        number
        url
        public
      }
    }
  }
`;

export const SET_PROJECT_PRIVATE_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!) {
    updateProjectV2(input: { projectId: $projectId, public: false }) {
      projectV2 {
        public
      }
    }
  }
`;

export const CREATE_TEXT_FIELD_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $name: String!) {
    createProjectV2Field(input: { projectId: $projectId, dataType: TEXT, name: $name }) {
      projectV2Field {
        ... on ProjectV2Field {
          id
        }
      }
    }
  }
`;

export const CREATE_SELECT_FIELD_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
    createProjectV2Field(
      input: { projectId: $projectId, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }
    ) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
        }
      }
    }
  }
`;

export const UPDATE_SELECT_FIELD_MUTATION = /* GraphQL */ `
  mutation ($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
    updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
        }
      }
    }
  }
`;

/**
 * Deletion rather than a disable, because Github offers no other lever: the
 * schema carries `deleteProjectV2Workflow` and no mutation that would turn one
 * off. A workflow deleted here can be written again by hand in the project's
 * settings, which is the way back for anyone who wants it.
 */
export const DELETE_PROJECT_WORKFLOW_MUTATION = /* GraphQL */ `
  mutation ($workflowId: ID!) {
    deleteProjectV2Workflow(input: { workflowId: $workflowId }) {
      deletedWorkflowId
    }
  }
`;

export const SET_ITEM_TEXT_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { text: $value } }
    ) {
      projectV2Item {
        id
      }
    }
  }
`;

export const CLEAR_ITEM_FIELD_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
      projectV2Item {
        id
      }
    }
  }
`;

export const SET_ITEM_SELECT_MUTATION = /* GraphQL */ `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
    ) {
      projectV2Item {
        id
      }
    }
  }
`;

/** The same read for a single-select, so the status write-then-confirm can check itself. */
export const READ_ITEM_SELECT_QUERY = /* GraphQL */ `
  query ($itemId: ID!) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        fieldValues(first: 100) {
          nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              optionId
              field {
                ... on ProjectV2FieldCommon {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;
