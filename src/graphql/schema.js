
const typeDefs = `#graphql
  # The dispatcher's read model. Every field maps to something a real person
  # looks at on the dashboard.

  type Query {
    "The board — all jobs, filterable. The list view."
    jobs(status: JobStatus, assignedTo: ID, search: String, limit: Int = 50): JobPage!

    "One job with its FULL history. The detail view — the whole tree in one call."
    job(id: ID!): Job

    "Fleet health — who is dark and for how long."
    drivers: [Driver!]!

    "The conflict inbox — everything the system refused to guess at."
    escalations: [Escalation!]!

    "The dark-time report — the number nobody else has."
    darkTimeReport(from: String, to: String): [DarkTimeRow!]!
  }

  type JobPage {
    items: [Job!]!
    total: Int!
  }

  type Job {
    id: ID!
    ref: String!
    status: JobStatus!
    version: Int!
    address: String
    codAmount: Int!
    price: Int!

    # These are the fields that would each be a separate REST call. In
    #   GraphQL the client asks for exactly the ones it needs, and DataLoader
    #   batches them so 50 jobs do not become 150 queries.
    customer: Customer
    driver: Driver

    "Every mutation that ever touched this job. The killer feature."
    history: [Mutation!]!

    createdAt: String!
    updatedAt: String!
  }

  type Customer {
    id: ID!
    name: String!
    phone: String
    address: String
  }

  type Driver {
    id: ID!
    name: String!
    role: String!

    "Seconds since we last heard from this driver's device."
    darkSeconds: Int

    "Derived health: online | dark | long_dark | never_synced"
    health: String!

    "How much company cash this driver is currently holding."
    cashOutstanding: Int!
  }

  # THE MUTATION TYPE — where the 'both timestamps' design becomes visible.
  type Mutation {
    id: ID!
    type: String!
    outcome: String!
    resolution: String

    "The human-readable WHY. Plain language, straight from the resolver."
    resolutionReason: String

    "When it HAPPENED, in the field."
    happenedAt: String!

    "When we HEARD about it."
    receivedAt: String!

    "The gap between the two. The dark time on THIS action."
    darkSeconds: Int!

    "Who did it, and from which device."
    actor: Driver
    deviceLabel: String
  }

  type Escalation {
    mutationId: ID!
    jobRef: String!
    reason: String!
    driverName: String
    darkSeconds: Int!
    receivedAt: String!
  }

  type DarkTimeRow {
    driverId: ID!
    driverName: String!
    mutations: Int!
    p50DarkSeconds: Int
    p95DarkSeconds: Int
    worstDarkSeconds: Int
  }

  enum JobStatus {
    draft
    assigned
    accepted
    picked_up
    delivered
    failed
    cancelled
  }
`;

module.exports = { typeDefs };
