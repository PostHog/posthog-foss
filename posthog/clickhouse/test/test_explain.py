import json
from dataclasses import dataclass

import pytest

from posthog.clickhouse.explain import (
    find_all_reads,
    guestimate_index_use,
    extract_index_usage_from_plan,
    ReadIndexUsage,
)
from posthog.schema import QueryIndexUsage


@dataclass
class DataTestCase:
    query: str
    reads: int
    reads_use: list[ReadIndexUsage]
    use: QueryIndexUsage
    plan: str


test_cases: list[DataTestCase] = [
    DataTestCase(
        query="a proper query with all filters on events",
        reads=1,
        reads_use=[ReadIndexUsage(table="posthog.sharded_events", use=QueryIndexUsage.YES)],
        use=QueryIndexUsage.YES,
        plan="""[
  {
    "Plan": {
      "Node Type": "Union",
      "Plans": [
        {
          "Node Type": "Expression",
          "Description": "(Projection + Before ORDER BY)",
          "Plans": [
            {
              "Node Type": "Expression",
              "Plans": [
                {
                  "Node Type": "ReadFromMergeTree",
                  "Description": "posthog.sharded_events",
                  "Indexes": [
                    {
                      "Type": "MinMax",
                      "Keys": [
                        "timestamp"
                      ],
                      "Condition": "(timestamp in ('1735828351', +Inf))",
                      "Initial Parts": 2799,
                      "Selected Parts": 222,
                      "Initial Granules": 173418552,
                      "Selected Granules": 26462626
                    },
                    {
                      "Type": "Partition",
                      "Keys": [
                        "toYYYYMM(timestamp)"
                      ],
                      "Condition": "(toYYYYMM(timestamp) in [202501, +Inf))",
                      "Initial Parts": 222,
                      "Selected Parts": 222,
                      "Initial Granules": 26462626,
                      "Selected Granules": 26462626
                    },
                    {
                      "Type": "PrimaryKey",
                      "Keys": [
                        "team_id",
                        "toDate(timestamp)",
                        "event"
                      ],
                      "Condition": "and((toDate(timestamp) in [20090, +Inf)), and((event in ['$pageview', '$pageview']), (team_id in [2, 2])))",
                      "Initial Parts": 222,
                      "Selected Parts": 181,
                      "Initial Granules": 26462626,
                      "Selected Granules": 35950
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "Node Type": "ReadFromRemote",
          "Description": "Read from remote replica"
        }
      ]
    }
  }
]
""",
    ),
    DataTestCase(
        query="missing timestamp condition",
        reads=1,
        reads_use=[ReadIndexUsage(table="posthog.sharded_events", use=QueryIndexUsage.NO)],
        use=QueryIndexUsage.NO,
        plan="""
[
  {
    "Plan": {
      "Node Type": "Union",
      "Plans": [
        {
          "Node Type": "Expression",
          "Description": "(Projection + Before ORDER BY)",
          "Plans": [
            {
              "Node Type": "Expression",
              "Plans": [
                {
                  "Node Type": "ReadFromMergeTree",
                  "Description": "posthog.sharded_events",
                  "Indexes": [
                    {
                      "Type": "MinMax",
                      "Condition": "true",
                      "Initial Parts": 2972,
                      "Selected Parts": 2972,
                      "Initial Granules": 171921031,
                      "Selected Granules": 171921031
                    },
                    {
                      "Type": "Partition",
                      "Condition": "true",
                      "Initial Parts": 2972,
                      "Selected Parts": 2972,
                      "Initial Granules": 171921031,
                      "Selected Granules": 171921031
                    },
                    {
                      "Type": "PrimaryKey",
                      "Keys": [
                        "team_id",
                        "event"
                      ],
                      "Condition": "and((event in ['$pageview', '$pageview']), (team_id in [2, 2]))",
                      "Initial Parts": 2972,
                      "Selected Parts": 1002,
                      "Initial Granules": 171921031,
                      "Selected Granules": 245218
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "Node Type": "ReadFromRemote",
          "Description": "Read from remote replica"
        }
      ]
    }
  }
]
""",
    ),
    DataTestCase(
        query="production query often failing cause ClickHouse not using index",
        reads=2,
        reads_use=[
            ReadIndexUsage(table="posthog.sharded_events", use=QueryIndexUsage.NO),
            ReadIndexUsage(table="posthog.person_distinct_id_overrides", use=QueryIndexUsage.YES),
        ],
        use=QueryIndexUsage.PARTIAL,
        plan="""
[
  {
    "Plan": {
      "Node Type": "Expression",
      "Description": "Projection",
      "Plans": [
        {
          "Node Type": "Limit",
          "Description": "preliminary LIMIT (without OFFSET)",
          "Plans": [
            {
              "Node Type": "Sorting",
              "Description": "Sorting for ORDER BY",
              "Plans": [
                {
                  "Node Type": "Expression",
                  "Description": "Before ORDER BY",
                  "Plans": [
                    {
                      "Node Type": "Aggregating",
                      "Plans": [
                        {
                          "Node Type": "Expression",
                          "Description": "(Before GROUP BY + (Projection + Before ORDER BY))",
                          "Plans": [
                            {
                              "Node Type": "MergingAggregated",
                              "Plans": [
                                {
                                  "Node Type": "Union",
                                  "Plans": [
                                    {
                                      "Node Type": "Aggregating",
                                      "Plans": [
                                        {
                                          "Node Type": "Expression",
                                          "Description": "(Before GROUP BY + )",
                                          "Plans": [
                                            {
                                              "Node Type": "Join",
                                              "Description": "JOIN FillRightFirst",
                                              "Plans": [
                                                {
                                                  "Node Type": "Expression",
                                                  "Plans": [
                                                    {
                                                      "Node Type": "ReadFromMergeTree",
                                                      "Description": "posthog.sharded_events",
                                                      "Indexes": [
                                                        {
                                                          "Type": "MinMax",
                                                          "Condition": "true",
                                                          "Initial Parts": 2759,
                                                          "Selected Parts": 2759,
                                                          "Initial Granules": 173438060,
                                                          "Selected Granules": 173438060
                                                        },
                                                        {
                                                          "Type": "Partition",
                                                          "Condition": "true",
                                                          "Initial Parts": 2759,
                                                          "Selected Parts": 2759,
                                                          "Initial Granules": 173438060,
                                                          "Selected Granules": 173438060
                                                        },
                                                        {
                                                          "Type": "PrimaryKey",
                                                          "Keys": [
                                                            "team_id"
                                                          ],
                                                          "Condition": "(team_id in [16617, 16617])",
                                                          "Initial Parts": 2759,
                                                          "Selected Parts": 1699,
                                                          "Initial Granules": 173438060,
                                                          "Selected Granules": 1877152
                                                        }
                                                      ]
                                                    }
                                                  ]
                                                },
                                                {
                                                  "Node Type": "Expression",
                                                  "Description": "(Joined actions + (Rename joined columns + (Projection + Before ORDER BY)))",
                                                  "Plans": [
                                                    {
                                                      "Node Type": "Filter",
                                                      "Description": "HAVING",
                                                      "Plans": [
                                                        {
                                                          "Node Type": "Aggregating",
                                                          "Plans": [
                                                            {
                                                              "Node Type": "Expression",
                                                              "Description": "Before GROUP BY",
                                                              "Plans": [
                                                                {
                                                                  "Node Type": "Expression",
                                                                  "Plans": [
                                                                    {
                                                                      "Node Type": "ReadFromMergeTree",
                                                                      "Description": "posthog.person_distinct_id_overrides",
                                                                      "Indexes": [
                                                                        {
                                                                          "Type": "PrimaryKey",
                                                                          "Keys": [
                                                                            "team_id"
                                                                          ],
                                                                          "Condition": "(team_id in [16617, 16617])",
                                                                          "Initial Parts": 18,
                                                                          "Selected Parts": 18,
                                                                          "Initial Granules": 155239,
                                                                          "Selected Granules": 18
                                                                        }
                                                                      ]
                                                                    }
                                                                  ]
                                                                }
                                                              ]
                                                            }
                                                          ]
                                                        }
                                                      ]
                                                    }
                                                  ]
                                                }
                                              ]
                                            }
                                          ]
                                        }
                                      ]
                                    },
                                    {
                                      "Node Type": "ReadFromRemote",
                                      "Description": "Read from remote replica"
                                    }
                                  ]
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  }
]
""",
    ),
    DataTestCase(
        query="local query little granules",
        reads=1,
        reads_use=[ReadIndexUsage(table="default.sharded_events", use=QueryIndexUsage.NO)],
        use=QueryIndexUsage.NO,
        plan="""
[
  {
    "Plan": {
      "Node Type": "Expression",
      "Description": "(Project names + Projection)",
      "Plans": [
        {
          "Node Type": "Limit",
          "Description": "preliminary LIMIT (without OFFSET)",
          "Plans": [
            {
              "Node Type": "Expression",
              "Plans": [
                {
                  "Node Type": "ReadFromMergeTree",
                  "Description": "default.sharded_events",
                  "Indexes": [
                    {
                      "Type": "MinMax",
                      "Condition": "true",
                      "Initial Parts": 12,
                      "Selected Parts": 12,
                      "Initial Granules": 39,
                      "Selected Granules": 39
                    },
                    {
                      "Type": "Partition",
                      "Condition": "true",
                      "Initial Parts": 12,
                      "Selected Parts": 12,
                      "Initial Granules": 39,
                      "Selected Granules": 39
                    },
                    {
                      "Type": "PrimaryKey",
                      "Keys": ["team_id"],
                      "Condition": "(team_id in [1, 1])",
                      "Initial Parts": 12,
                      "Selected Parts": 9,
                      "Initial Granules": 39,
                      "Selected Granules": 32
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  }
]
""",
    ),
    DataTestCase(
        query="local query little granules, using index",
        reads=1,
        reads_use=[ReadIndexUsage(table="default.sharded_events", use=QueryIndexUsage.YES)],
        use=QueryIndexUsage.YES,
        plan="""
[
  {
    "Plan": {
      "Node Type": "Expression",
      "Description": "(Project names + Projection)",
      "Plans": [
        {
          "Node Type": "Limit",
          "Description": "preliminary LIMIT (without OFFSET)",
          "Plans": [
            {
              "Node Type": "Expression",
              "Plans": [
                {
                  "Node Type": "ReadFromMergeTree",
                  "Description": "default.sharded_events",
                  "Indexes": [
                    {
                      "Type": "MinMax",
                      "Keys": ["timestamp"],
                      "Condition": "(toTimezone(timestamp, 'UTC') in ('1735831217', +Inf))",
                      "Initial Parts": 11,
                      "Selected Parts": 6,
                      "Initial Granules": 38,
                      "Selected Granules": 32
                    },
                    {
                      "Type": "Partition",
                      "Condition": "true",
                      "Initial Parts": 6,
                      "Selected Parts": 6,
                      "Initial Granules": 32,
                      "Selected Granules": 32
                    },
                    {
                      "Type": "PrimaryKey",
                      "Keys": ["team_id"],
                      "Condition": "(team_id in [1, 1])",
                      "Initial Parts": 6,
                      "Selected Parts": 5,
                      "Initial Granules": 32,
                      "Selected Granules": 27
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  }
]
""",
    ),
    DataTestCase(
        query="session query not using indices",
        reads=1,
        reads_use=[ReadIndexUsage(table="posthog.sharded_raw_sessions", use=QueryIndexUsage.PARTIAL)],
        use=QueryIndexUsage.PARTIAL,
        plan="""
[
   {
      "Plan" : {
         "Description" : "(Projection + (Before ORDER BY + (WHERE + (Projection + Before ORDER BY))))",
         "Node Type" : "Expression",
         "Plans" : [
            {
               "Description" : "preliminary LIMIT (without OFFSET)",
               "Node Type" : "Limit",
               "Plans" : [
                  {
                     "Description" : "((WHERE + (Projection + Before ORDER BY)))[split]",
                     "Node Type" : "Filter",
                     "Plans" : [
                        {
                           "Description" : "HAVING",
                           "Node Type" : "Filter",
                           "Plans" : [
                              {
                                 "Node Type" : "MergingAggregated",
                                 "Plans" : [
                                    {
                                       "Node Type" : "Union",
                                       "Plans" : [
                                          {
                                             "Node Type" : "Aggregating",
                                             "Plans" : [
                                                {
                                                   "Description" : "Before GROUP BY",
                                                   "Node Type" : "Expression",
                                                   "Plans" : [
                                                      {
                                                         "Node Type" : "Expression",
                                                         "Plans" : [
                                                            {
                                                               "Description" : "posthog.sharded_raw_sessions",
                                                               "Indexes" : [
                                                                  {
                                                                     "Condition" : "true",
                                                                     "Initial Granules" : 4238362,
                                                                     "Initial Parts" : 1516,
                                                                     "Selected Granules" : 4238362,
                                                                     "Selected Parts" : 1516,
                                                                     "Type" : "MinMax"
                                                                  },
                                                                  {
                                                                     "Condition" : "true",
                                                                     "Initial Granules" : 4238362,
                                                                     "Initial Parts" : 1516,
                                                                     "Selected Granules" : 4238362,
                                                                     "Selected Parts" : 1516,
                                                                     "Type" : "Partition"
                                                                  },
                                                                  {
                                                                     "Condition" : "(team_id in [2, 2])",
                                                                     "Initial Granules" : 4238362,
                                                                     "Initial Parts" : 1516,
                                                                     "Keys" : [
                                                                        "team_id"
                                                                     ],
                                                                     "Selected Granules" : 7616,
                                                                     "Selected Parts" : 150,
                                                                     "Type" : "PrimaryKey"
                                                                  }
                                                               ],
                                                               "Node Type" : "ReadFromMergeTree"
                                                            }
                                                         ]
                                                      }
                                                   ]
                                                }
                                             ]
                                          },
                                          {
                                             "Description" : "Read from remote replica",
                                             "Node Type" : "ReadFromRemote"
                                          }
                                       ]
                                    }
                                 ]
                              }
                           ]
                        }
                     ]
                  }
               ]
            }
         ]
      }
   }
]
""",
    ),
]


@pytest.mark.parametrize("case", test_cases, ids=[x.query for x in test_cases])
def test_full_queries(case, snapshot):
    explain = json.loads(case.plan)
    reads = find_all_reads(explain[0])
    assert case.reads == len(reads)
    reads_use = [guestimate_index_use(r) for r in reads]
    assert case.reads_use == reads_use
    assert case.use == extract_index_usage_from_plan(case.plan)

    assert case.plan == snapshot
    assert snapshot == len(reads)
    assert snapshot == reads_use
    assert snapshot == extract_index_usage_from_plan(case.plan)
