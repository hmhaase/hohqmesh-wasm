!
!  Samples the boundary curves of a control file's MODEL block with HOHQMesh's own
!  curve classes, so the web front end can draw the geometry before meshing.
!
!  Usage: BoundaryPreview <control file> <output file>
!
!  Output format, repeated per curve:
!     CURVE <outer|inner> <chain name> | <curve name>
!     x y
!     ...
!
      PROGRAM BoundaryPreview
         USE ProgramGlobals
         USE FTValueDictionaryClass
         USE SharedExceptionManagerModule
         USE SMModelClass
         USE SMChainedCurveClass
         USE SMSplineCurveClass
         USE HOHQMeshModule, ONLY : ReadControlFile
         IMPLICIT NONE

         INTEGER, PARAMETER :: MIN_SAMPLES = 200, SAMPLES_PER_KNOT = 8

         CHARACTER(LEN=DEFAULT_CHARACTER_LENGTH) :: controlFileName, outputFileName
         CHARACTER(LEN=5)                        :: chainKind
         TYPE (FTValueDictionary), POINTER       :: projectDict
         CLASS(FTValueDictionary), POINTER       :: modelDict
         CLASS(FTObject)         , POINTER       :: obj
         TYPE (SMModel)          , POINTER       :: model
         CLASS(SMChainedCurve)   , POINTER       :: chain
         CLASS(SMCurve)          , POINTER       :: curve
         INTEGER                                 :: j, k, i, nSamples, fUnit
         REAL(KIND=RP)                           :: x(3)

         CALL initializeFTExceptions
         CALL GET_COMMAND_ARGUMENT(1, controlFileName)
         CALL GET_COMMAND_ARGUMENT(2, outputFileName)
         CALL ReadControlFile(controlFileName, projectDict)
         IF ( catch() ) CALL trapExceptions

         OPEN(NEWUNIT = fUnit, FILE = outputFileName)

         obj => projectDict % objectForKey(key = "MODEL")
         IF ( ASSOCIATED(obj) )     THEN
            modelDict => valueDictionaryFromObject(obj)
            ALLOCATE(model)
            CALL model % initWithContentsOfDictionary(modelDict)
            IF ( catch() ) CALL trapExceptions

            DO j = 1, model % numberOfChains()
               CALL castToSMChainedCurve(model % allChains(j) % object, chain)
               chainKind = "inner"
               IF ( ASSOCIATED(model % outerBoundary) )     THEN
                  IF ( chain % id() == model % outerBoundary % id() ) chainKind = "outer"
               END IF

               DO k = 1, chain % COUNT()
                  curve => chain % curveAtIndex(k)
                  nSamples = MIN_SAMPLES
                  SELECT TYPE ( curve )
                     TYPE IS ( SMSplineCurve )
                        nSamples = MAX(MIN_SAMPLES, SAMPLES_PER_KNOT*curve % numKnots)
                  END SELECT

                  WRITE(fUnit, '(5A)') "CURVE ", chainKind, " ", TRIM(chain % curveName()) // " | ", &
                                       TRIM(curve % curveName())
                  DO i = 0, nSamples
                     x = curve % positionAt(REAL(i, RP)/nSamples)
                     WRITE(fUnit, '(2ES24.15)') x(1), x(2)
                  END DO
               END DO
            END DO
         END IF

         CLOSE(fUnit)
         CALL destructFTExceptions

      END PROGRAM BoundaryPreview
