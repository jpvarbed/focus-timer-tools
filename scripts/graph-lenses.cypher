// Fleet provenance — starter lenses for the Neo4j Aura console (console.neo4j.io → 4ceadc9b → Query).
// Paste a block and hit ▶. Schema: (Agent)-[:WORKS_IN]->(Project), (Agent)-[:ON]->(Task),
// (Project)-[:CONTAINS]->(Task), (Agent)-[:MADE]->(Event), (Event)-[:INFORMS]->(Knowledge),
// (Event)-[:PRODUCES]->(Commit|File). Event.type ∈ {decision, output}; Event.knowledgeGap : bool.

// 1) THE LINEAGE — decisions and the knowledge they cite (the headline view)
MATCH (a:Agent)-[:MADE]->(d:Event {type:'decision'})-[:INFORMS]->(k:Knowledge)
RETURN a, d, k;

// 2) MOST-CITED KNOWLEDGE (table)
MATCH (k:Knowledge)<-[:INFORMS]-(d:Event)
RETURN k.slug AS concept, k.title AS title, count(d) AS cited_by
ORDER BY cited_by DESC;

// 3) ONE CONCEPT'S NEIGHBORHOOD — who cited it + what else those decisions produced
MATCH (k:Knowledge {slug:'keyed-read-surface-foc-28'})<-[:INFORMS]-(d)<-[:MADE]-(a)
OPTIONAL MATCH (d)-[:PRODUCES]->(o)
RETURN k, d, a, o;

// 4) WHAT AN AGENT PRODUCED — its commits + files (swap the id)
MATCH (a:Agent {id:'cc-f0c0a5'})-[:MADE]->(e)-[:PRODUCES]->(o)
RETURN a, e, o;

// 5) A PROJECT, END TO END — its agents + tasks (swap the name)
MATCH (p:Project {name:'pnw-golf-ai'})
OPTIONAL MATCH (a:Agent)-[:WORKS_IN]->(p)
OPTIONAL MATCH (p)-[:CONTAINS]->(t:Task)
RETURN p, a, t;

// 6) KNOWLEDGE GAPS — decisions that cited nothing (the audit signal)
MATCH (a:Agent)-[:MADE]->(d:Event {type:'decision'})
WHERE d.knowledgeGap = true
RETURN a.id AS agent, d.summary AS decision, d.ts AS ts
ORDER BY ts DESC;

// 7) MOST PRODUCTIVE AGENTS — by commit count
MATCH (a:Agent)-[:MADE]->(:Event)-[:PRODUCES]->(c:Commit)
RETURN a.id AS agent, count(c) AS commits
ORDER BY commits DESC LIMIT 10;

// 8) JUST LOOK AROUND — the whole graph, capped (use Explore/Graph view, not Table)
MATCH (n) RETURN n LIMIT 300;
