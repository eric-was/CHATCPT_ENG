import React, { useMemo, useState } from "react";
import "./styles.css";

type SupportType = "free" | "pinned" | "fixed";

type Support = {
  id: number;
  positionMm: number;
  type: SupportType;
};

type PointLoad = {
  id: number;
  positionMm: number;
  magnitudeKn: number;
};

type Udl = {
  id: number;
  startMm: number;
  endMm: number;
  magnitudeKnPerM: number;
};

type Node = {
  x: number;
  supportType: SupportType;
};

type ElementData = {
  index: number;
  length: number;
  wNPerMm: number;
  kLocal: number[][];
  fFixed: number[];
};

type AnalysisResult = {
  nodes: Node[];
  reactionTable: {
    positionMm: number;
    verticalKn: number;
    momentKnM: number;
    type: SupportType;
  }[];
  diagrams: { x: number; shear: number; moment: number; deflection: number }[];
  error?: undefined;
};

type AnalysisError = {
  error: string;
};

const DEFAULT_SUPPORTS: Support[] = [
  { id: 1, positionMm: 0, type: "fixed" },
  { id: 2, positionMm: 3000, type: "pinned" },
];

const DEFAULT_POINT_LOADS: PointLoad[] = [
  { id: 1, positionMm: 1500, magnitudeKn: 8 },
];

const DEFAULT_UDLS: Udl[] = [
  { id: 1, startMm: 500, endMm: 2500, magnitudeKnPerM: 4 },
];

const SUPPORT_TYPES: { value: SupportType; label: string }[] = [
  { value: "free", label: "Free" },
  { value: "pinned", label: "Pinned" },
  { value: "fixed", label: "Fixed" },
];

const formatNumber = (value: number, digits = 2) =>
  Number.isFinite(value) ? value.toFixed(digits) : "-";

const uniqueSorted = (values: number[]) =>
  Array.from(new Set(values)).sort((a, b) => a - b);

const buildNodes = ({
  lengthMm,
  supports,
  pointLoads,
  udls,
}: {
  lengthMm: number;
  supports: Support[];
  pointLoads: PointLoad[];
  udls: Udl[];
}) => {
  const basePositions = [0, lengthMm];
  supports.forEach((support) => basePositions.push(support.positionMm));
  pointLoads.forEach((load) => basePositions.push(load.positionMm));
  udls.forEach((udl) => {
    basePositions.push(udl.startMm, udl.endMm);
  });

  const positions = uniqueSorted(
    basePositions.filter((pos) => pos >= 0 && pos <= lengthMm)
  );

  return positions.map((position) => {
    const support = supports.find((item) => item.positionMm === position);
    return {
      x: position,
      supportType: support?.type ?? "free",
    };
  });
};

const mapLoadsToNodes = (nodes: Node[], pointLoads: PointLoad[]) => {
  const nodeLoads = new Array(nodes.length).fill(0);
  pointLoads.forEach((load) => {
    const index = nodes.findIndex((node) => node.x === load.positionMm);
    if (index >= 0) {
      nodeLoads[index] += -load.magnitudeKn * 1000;
    }
  });
  return nodeLoads;
};

const getElementUdl = (udls: Udl[], xStart: number, xEnd: number) => {
  const mid = (xStart + xEnd) / 2;
  return udls
    .filter((udl) => mid >= udl.startMm && mid <= udl.endMm)
    .reduce((sum, udl) => sum + udl.magnitudeKnPerM, 0);
};

const assembleSystem = ({
  nodes,
  youngsModulusMpa,
  inertiaMm4,
  pointLoads,
  udls,
}: {
  nodes: Node[];
  youngsModulusMpa: number;
  inertiaMm4: number;
  pointLoads: PointLoad[];
  udls: Udl[];
}) => {
  const dof = nodes.length * 2;
  const K = Array.from({ length: dof }, () => Array(dof).fill(0));
  const F = Array(dof).fill(0);
  const nodePointLoads = mapLoadsToNodes(nodes, pointLoads);

  nodes.forEach((_, index) => {
    F[index * 2] += nodePointLoads[index];
  });

  const EI = youngsModulusMpa * inertiaMm4; // N/mm^2 * mm^4 = N*mm^2

  const elementData: ElementData[] = [];

  for (let i = 0; i < nodes.length - 1; i += 1) {
    const x1 = nodes[i].x;
    const x2 = nodes[i + 1].x;
    const L = x2 - x1;
    if (L <= 0) continue;

    const wKnPerM = getElementUdl(udls, x1, x2);
    const w = -wKnPerM; // kN/m, negative for downward
    const wNPerMm = w; // 1 kN/m = 1 N/mm

    const L2 = L * L;
    const L3 = L2 * L;
    const factor = EI / L3;

    const kLocal = [
      [12, 6 * L, -12, 6 * L],
      [6 * L, 4 * L2, -6 * L, 2 * L2],
      [-12, -6 * L, 12, -6 * L],
      [6 * L, 2 * L2, -6 * L, 4 * L2],
    ].map((row) => row.map((value) => value * factor));

    const fFixed = [
      (wNPerMm * L) / 2,
      (wNPerMm * L2) / 12,
      (wNPerMm * L) / 2,
      -(wNPerMm * L2) / 12,
    ];

    const dofMap = [i * 2, i * 2 + 1, (i + 1) * 2, (i + 1) * 2 + 1];

    for (let r = 0; r < 4; r += 1) {
      F[dofMap[r]] += fFixed[r];
      for (let c = 0; c < 4; c += 1) {
        K[dofMap[r]][dofMap[c]] += kLocal[r][c];
      }
    }

    elementData.push({
      index: i,
      length: L,
      wNPerMm,
      kLocal,
      fFixed,
    });
  }

  return { K, F, elementData };
};

const applyBoundaryConditions = (nodes: Node[], K: number[][], F: number[]) => {
  const constrained: number[] = [];
  nodes.forEach((node, index) => {
    if (node.supportType === "pinned") {
      constrained.push(index * 2);
    }
    if (node.supportType === "fixed") {
      constrained.push(index * 2, index * 2 + 1);
    }
  });

  const free = Array.from({ length: K.length }, (_, i) => i).filter(
    (i) => !constrained.includes(i)
  );

  const Kff = free.map((r) => free.map((c) => K[r][c]));
  const Ff = free.map((r) => F[r]);

  return { constrained, free, Kff, Ff };
};

const solveLinearSystem = (A: number[][], b: number[]) => {
  const n = b.length;
  const M = A.map((row) => row.slice());
  const x = b.slice();

  for (let k = 0; k < n; k += 1) {
    let maxRow = k;
    for (let i = k + 1; i < n; i += 1) {
      if (Math.abs(M[i][k]) > Math.abs(M[maxRow][k])) {
        maxRow = i;
      }
    }
    if (Math.abs(M[maxRow][k]) < 1e-9) {
      return null;
    }
    [M[k], M[maxRow]] = [M[maxRow], M[k]];
    [x[k], x[maxRow]] = [x[maxRow], x[k]];

    const pivot = M[k][k];
    for (let j = k; j < n; j += 1) {
      M[k][j] /= pivot;
    }
    x[k] /= pivot;

    for (let i = 0; i < n; i += 1) {
      if (i === k) continue;
      const factor = M[i][k];
      for (let j = k; j < n; j += 1) {
        M[i][j] -= factor * M[k][j];
      }
      x[i] -= factor * x[k];
    }
  }

  return x;
};

const computeDiagrams = (
  nodes: Node[],
  elementData: ElementData[],
  displacements: number[]
) => {
  const samples: { x: number; shear: number; moment: number; deflection: number }[] = [];

  elementData.forEach((element) => {
    const { index, length, wNPerMm, kLocal, fFixed } = element;
    const dofMap = [index * 2, index * 2 + 1, (index + 1) * 2, (index + 1) * 2 + 1];
    const uLocal = dofMap.map((dof) => displacements[dof]);

    const endForces = kLocal.map((row, r) =>
      row.reduce((sum, value, c) => sum + value * uLocal[c], 0) - fFixed[r]
    );

    const v1 = uLocal[0];
    const t1 = uLocal[1];
    const v2 = uLocal[2];
    const t2 = uLocal[3];

    const numPoints = 40;
    for (let i = 0; i <= numPoints; i += 1) {
      const x = (length * i) / numPoints;
      const r = x / length;
      const n1 = 1 - 3 * r * r + 2 * r * r * r;
      const n2 = length * (r - 2 * r * r + r * r * r);
      const n3 = 3 * r * r - 2 * r * r * r;
      const n4 = length * (-r * r + r * r * r);
      const deflection = n1 * v1 + n2 * t1 + n3 * v2 + n4 * t2;

      const shear = endForces[0] - wNPerMm * x;
      const moment = endForces[1] + endForces[0] * x - (wNPerMm * x * x) / 2;

      samples.push({
        x: nodes[index].x + x,
        shear,
        moment,
        deflection,
      });
    }
  });

  return samples;
};

const scalePoints = (data: { x: number; [key: string]: number }[], yKey: string, width: number, height: number) => {
  const values = data.map((item) => item[yKey] ?? 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return data.map((item) => ({
    x: (item.x / data[data.length - 1].x) * width,
    y: height - ((item[yKey] - min) / span) * height,
  }));
};

const BeamCalculator = () => {
  const [lengthMm, setLengthMm] = useState(3000);
  const [widthMm, setWidthMm] = useState(45);
  const [depthMm, setDepthMm] = useState(190);
  const [youngsModulusMpa, setYoungsModulusMpa] = useState(10000);
  const [supports, setSupports] = useState<Support[]>(DEFAULT_SUPPORTS);
  const [pointLoads, setPointLoads] = useState<PointLoad[]>(DEFAULT_POINT_LOADS);
  const [udls, setUdls] = useState<Udl[]>(DEFAULT_UDLS);

  const inertiaMm4 = useMemo(() => {
    return (widthMm * Math.pow(depthMm, 3)) / 12;
  }, [widthMm, depthMm]);

  const analysis = useMemo<AnalysisResult | AnalysisError>(() => {
    const nodes = buildNodes({ lengthMm, supports, pointLoads, udls });

    const { K, F, elementData } = assembleSystem({
      nodes,
      youngsModulusMpa,
      inertiaMm4,
      pointLoads,
      udls,
    });

    const { free, Kff, Ff } = applyBoundaryConditions(nodes, K, F);
    const freeDisplacements = solveLinearSystem(Kff, Ff);

    if (!freeDisplacements) {
      return {
        error:
          "The system is unstable. Add or adjust supports so at least one vertical and one rotational restraint exists.",
      };
    }

    const displacements = Array(K.length).fill(0);
    free.forEach((index, i) => {
      displacements[index] = freeDisplacements[i];
    });

    const reactions = K.map((row, i) =>
      row.reduce((sum, value, j) => sum + value * displacements[j], 0) - F[i]
    );

    const reactionTable = nodes
      .map((node, index) => {
        const vertical = reactions[index * 2];
        const moment = reactions[index * 2 + 1];
        if (node.supportType === "free") return null;
        return {
          positionMm: node.x,
          verticalKn: vertical / 1000,
          momentKnM: moment / 1e6,
          type: node.supportType,
        };
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    const diagrams = computeDiagrams(nodes, elementData, displacements);

    return { nodes, reactionTable, diagrams };
  }, [
    lengthMm,
    supports,
    pointLoads,
    udls,
    youngsModulusMpa,
    inertiaMm4,
  ]);

  const handleSupportChange = (id: number, field: keyof Support, value: number | SupportType) => {
    setSupports((prev) =>
      prev.map((support) =>
        support.id === id ? { ...support, [field]: value } : support
      )
    );
  };

  const handlePointLoadChange = (id: number, field: keyof PointLoad, value: number) => {
    setPointLoads((prev) =>
      prev.map((load) => (load.id === id ? { ...load, [field]: value } : load))
    );
  };

  const handleUdlChange = (id: number, field: keyof Udl, value: number) => {
    setUdls((prev) =>
      prev.map((udl) => (udl.id === id ? { ...udl, [field]: value } : udl))
    );
  };

  const addSupport = () => {
    setSupports((prev) => [
      ...prev,
      { id: Date.now(), positionMm: lengthMm / 2, type: "pinned" },
    ]);
  };

  const addPointLoad = () => {
    setPointLoads((prev) => [
      ...prev,
      { id: Date.now(), positionMm: lengthMm / 2, magnitudeKn: 5 },
    ]);
  };

  const addUdl = () => {
    setUdls((prev) => [
      ...prev,
      { id: Date.now(), startMm: 0, endMm: lengthMm, magnitudeKnPerM: 2 },
    ]);
  };

  const removeItem = <T extends { id: number }>(setter: React.Dispatch<React.SetStateAction<T[]>>, id: number) => {
    setter((prev) => prev.filter((item) => item.id !== id));
  };

  const diagrams = "diagrams" in analysis ? analysis.diagrams : [];
  const shearPoints = diagrams.length
    ? scalePoints(diagrams, "shear", 600, 140)
    : [];
  const momentPoints = diagrams.length
    ? scalePoints(diagrams, "moment", 600, 140)
    : [];
  const deflectionPoints = diagrams.length
    ? scalePoints(diagrams, "deflection", 600, 140)
    : [];

  return (
    <div className="beam-app">
      <header>
        <div>
          <p className="eyebrow">Prismatic Euler–Bernoulli Beam</p>
          <h1>Reactions, Shear, Moment & Deflection</h1>
          <p className="subtext">
            Supports can be free, pinned, or fixed. Loads are downward-positive
            inputs (kN and kN/m). Results use kN and kN·m with deflection in mm.
          </p>
        </div>
        <div className="badge">190×45 MGP10 · L = 3000 mm</div>
      </header>

      <section className="grid">
        <div className="card">
          <h2>Member Properties</h2>
          <div className="field-group">
            <label>
              Span (mm)
              <input
                type="number"
                value={lengthMm}
                onChange={(event) => setLengthMm(Number(event.target.value))}
              />
            </label>
            <label>
              Width (mm)
              <input
                type="number"
                value={widthMm}
                onChange={(event) => setWidthMm(Number(event.target.value))}
              />
            </label>
            <label>
              Depth (mm)
              <input
                type="number"
                value={depthMm}
                onChange={(event) => setDepthMm(Number(event.target.value))}
              />
            </label>
            <label>
              E (MPa)
              <input
                type="number"
                value={youngsModulusMpa}
                onChange={(event) =>
                  setYoungsModulusMpa(Number(event.target.value))
                }
              />
            </label>
          </div>
          <div className="note">
            Section I = {formatNumber(inertiaMm4 / 1e6, 2)} × 10⁶ mm⁴
          </div>
        </div>

        <div className="card">
          <h2>Supports</h2>
          {supports.map((support) => (
            <div className="row" key={support.id}>
              <input
                type="number"
                value={support.positionMm}
                onChange={(event) =>
                  handleSupportChange(
                    support.id,
                    "positionMm",
                    Number(event.target.value)
                  )
                }
              />
              <select
                value={support.type}
                onChange={(event) =>
                  handleSupportChange(
                    support.id,
                    "type",
                    event.target.value as SupportType
                  )
                }
              >
                {SUPPORT_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost"
                onClick={() => removeItem(setSupports, support.id)}
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addSupport}>
            Add Support
          </button>
        </div>

        <div className="card">
          <h2>Point Loads (kN)</h2>
          {pointLoads.map((load) => (
            <div className="row" key={load.id}>
              <input
                type="number"
                value={load.positionMm}
                onChange={(event) =>
                  handlePointLoadChange(
                    load.id,
                    "positionMm",
                    Number(event.target.value)
                  )
                }
              />
              <input
                type="number"
                value={load.magnitudeKn}
                onChange={(event) =>
                  handlePointLoadChange(
                    load.id,
                    "magnitudeKn",
                    Number(event.target.value)
                  )
                }
              />
              <button
                type="button"
                className="ghost"
                onClick={() => removeItem(setPointLoads, load.id)}
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addPointLoad}>
            Add Point Load
          </button>
        </div>

        <div className="card">
          <h2>UDL (kN/m)</h2>
          {udls.map((udl) => (
            <div className="row" key={udl.id}>
              <input
                type="number"
                value={udl.startMm}
                onChange={(event) =>
                  handleUdlChange(
                    udl.id,
                    "startMm",
                    Number(event.target.value)
                  )
                }
              />
              <input
                type="number"
                value={udl.endMm}
                onChange={(event) =>
                  handleUdlChange(
                    udl.id,
                    "endMm",
                    Number(event.target.value)
                  )
                }
              />
              <input
                type="number"
                value={udl.magnitudeKnPerM}
                onChange={(event) =>
                  handleUdlChange(
                    udl.id,
                    "magnitudeKnPerM",
                    Number(event.target.value)
                  )
                }
              />
              <button
                type="button"
                className="ghost"
                onClick={() => removeItem(setUdls, udl.id)}
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addUdl}>
            Add UDL
          </button>
        </div>
      </section>

      <section className="card results">
        <h2>Results</h2>
        {"error" in analysis ? (
          <p className="error">{analysis.error}</p>
        ) : (
          <>
            <div className="grid-two">
              <div>
                <h3>Support Reactions</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Position (mm)</th>
                      <th>Type</th>
                      <th>V (kN)</th>
                      <th>M (kN·m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.reactionTable.map((reaction) => (
                      <tr key={`${reaction.positionMm}-${reaction.type}`}>
                        <td>{reaction.positionMm}</td>
                        <td>{reaction.type}</td>
                        <td>{formatNumber(reaction.verticalKn, 3)}</td>
                        <td>{formatNumber(reaction.momentKnM, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="note">
                Cantilever ends are automatically detected when no support is
                defined at the beam boundary. Rotations are free unless fixed.
              </div>
            </div>

            <div className="diagram">
              <h3>Shear Diagram (kN)</h3>
              <svg viewBox="0 0 600 140">
                <polyline
                  points={shearPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                />
              </svg>
            </div>

            <div className="diagram">
              <h3>Moment Diagram (kN·m)</h3>
              <svg viewBox="0 0 600 140">
                <polyline
                  points={momentPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                />
              </svg>
            </div>

            <div className="diagram">
              <h3>Deflection (mm)</h3>
              <svg viewBox="0 0 600 140">
                <polyline
                  points={deflectionPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                />
              </svg>
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default BeamCalculator;
