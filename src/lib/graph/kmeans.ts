export interface KMeansResult {
  assignments: number[];
  centroids: number[][];
}

function squaredDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

/**
 * Farthest-point sampling for initial centroids: deterministic (no RNG),
 * and spreads the starting centroids across the data instead of risking
 * several landing in the same cluster, which plain random init can do.
 */
function initCentroids(points: number[][], k: number): number[][] {
  const centroids: number[][] = [points[0]];
  while (centroids.length < k) {
    let farthestPoint = points[0];
    let farthestDist = -Infinity;
    for (const point of points) {
      const minDist = Math.min(...centroids.map((c) => squaredDistance(point, c)));
      if (minDist > farthestDist) {
        farthestDist = minDist;
        farthestPoint = point;
      }
    }
    centroids.push(farthestPoint);
  }
  return centroids;
}

/** Plain Lloyd's-algorithm k-means. Points are 384-dim, already L2-normalized
 * embeddings, so squared-euclidean distance ranking matches cosine-similarity
 * ranking here - no separate cosine variant needed. */
export function kmeans(points: number[][], k: number, maxIterations = 25): KMeansResult {
  if (points.length === 0) return { assignments: [], centroids: [] };

  const effectiveK = Math.min(k, points.length);
  let centroids = initCentroids(points, effectiveK);
  let assignments = new Array(points.length).fill(-1);

  for (let iter = 0; iter < maxIterations; iter++) {
    const newAssignments = points.map((point) => {
      let best = 0;
      let bestDist = Infinity;
      centroids.forEach((centroid, i) => {
        const dist = squaredDistance(point, centroid);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    });

    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;
    if (!changed && iter > 0) break;

    const dims = points[0].length;
    const sums = Array.from({ length: effectiveK }, () => new Array(dims).fill(0));
    const counts = new Array(effectiveK).fill(0);
    points.forEach((point, i) => {
      const cluster = assignments[i];
      counts[cluster]++;
      for (let d = 0; d < dims; d++) sums[cluster][d] += point[d];
    });
    centroids = sums.map((sum, i) =>
      counts[i] === 0 ? centroids[i] : sum.map((v) => v / counts[i])
    );
  }

  return { assignments, centroids };
}
