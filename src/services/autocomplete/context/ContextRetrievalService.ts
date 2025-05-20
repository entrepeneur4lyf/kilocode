import { IDE } from "../utils/ide"

import { ImportDefinitionsService } from "./ImportDefinitionsService"
import { RootPathContextService } from "./root-path-context/RootPathContextService"

export class ContextRetrievalService {
	private importDefinitionsService: ImportDefinitionsService
	private rootPathContextService: RootPathContextService

	constructor(private readonly ide: IDE) {
		this.importDefinitionsService = new ImportDefinitionsService(this.ide)
		this.rootPathContextService = new RootPathContextService(this.importDefinitionsService, this.ide)
	}
}
