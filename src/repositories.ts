import type { SpotRepository } from "./ports.js";

export class InMemorySpotRepository<TSpot extends { id: string }> implements SpotRepository<TSpot> {
  public constructor(private readonly spots: TSpot[] = []) {}
  public async getDailySpots(): Promise<TSpot[]> { return [...this.spots]; }
  public async getById(id: string): Promise<TSpot | null> { return this.spots.find((spot) => spot.id === id) ?? null; }
}
