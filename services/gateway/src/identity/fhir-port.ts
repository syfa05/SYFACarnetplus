/** Réaffectation des références FHIR lors d'une fusion (implémentée au lot L6). */
export interface FhirReferenceReassigner {
  /** Réaffecte les ressources du dossier absorbé vers le dossier conservé ; retourne de quoi annuler. */
  reassign(fromId: string, toId: string): Promise<unknown[]>;
  restore(fromId: string, toId: string, refs: unknown[]): Promise<void>;
}

/** Tant que le serveur FHIR n'est pas branché : rien à réaffecter. */
export const noFhirReassigner: FhirReferenceReassigner = {
  reassign: async () => [],
  restore: async () => {},
};
