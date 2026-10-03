# MovingAI MAPF benchmarks

The grid maps and scenarios of the [Moving AI MAPF benchmarks](https://movingai.com/benchmarks/mapf/index.html), organized for the MAPF benchmarking harness that uses this repository as a submodule:

> Roni Stern, Nathan R. Sturtevant, Ariel Felner, Sven Koenig, Hang Ma, Thayne T. Walker, Jiaoyang Li, Dor Atzmon, Liron Cohen, T. K. Satish Kumar, Eli Boyarski and Roman Barták. Multi-Agent Pathfinding: Definitions, Variants, and Benchmarks. Symposium on Combinatorial Search (SoCS), 2019.

## Layout

One directory per map, holding the map and its 25 random and 25 even scenarios:

```text
empty-8-8/
    empty-8-8.map
    empty-8-8-random-1.scen ... empty-8-8-random-25.scen
    empty-8-8-even-1.scen   ... empty-8-8-even-25.scen
```

A scenario file names its map by file name only, and solvers that read the MovingAI files themselves look for the map in the scenario's directory, so the two are kept together.

There are 33 maps: empty, random, room, maze, warehouse, city (`Berlin_1_256`, `Boston_0_256`, `Paris_1_256`) and game maps (`brc202d`, `den312d`, `den520d`, `ht_chantry`, `ht_mansion_n`, `lak303d`, `lt_gallowstemplar_n`, `orz900d`, `ost003d`, `w_woundedcoast`).

- **random** scenarios place the agents' starts and goals at random.
- **even** scenarios have 10 agents in each bucket (the first column of each line: the agent's optimal single-agent path length divided by 4, rounded down), so short and long paths are equally common. The lines are not sorted by bucket, so the first n agents are also a mix.

A scenario lists up to 1000 agents (fewer on small maps). The problem with n agents is the first n agents of a scenario, in file order.
