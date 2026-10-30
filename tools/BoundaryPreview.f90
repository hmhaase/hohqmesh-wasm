!
!  Samples the geometry of a control file with HOHQMesh's own classes, so the web
!  front end can draw it before meshing: the MODEL boundary curves, the sweep curve,
!  and, when there are no boundary curves, the BACKGROUND_GRID box. Points are lifted
!  onto the bottom TOPOGRAPHY, then a SIMPLE_EXTRUSION or SIMPLE_ROTATION is applied
!  with the routines generate3DMesh uses, so the outline is in mesh coordinates. A
!  SWEEP_ALONG_CURVE is not applied (HOHQMesh sweeps the hex mesh with Frenet frames);
!  its cross-section is written as is.
!
!  Usage: BoundaryPreview <control file> <output file>
!
!  Output format:
!     GENERATOR <none|extrusion|rotation|sweep>
!  then, repeated per polyline:
!     CURVE <outer|inner|box|sweep|section|rail> <chain name> | <curve name>
!     x y z
!     ...
!
      PROGRAM BoundaryPreview
         USE ProgramGlobals
         USE FTValueDictionaryClass
         USE SharedExceptionManagerModule
         USE SMModelClass
         USE SMChainedCurveClass
         USE SMSplineCurveClass
         USE MeshController3D
         USE SimpleSweepModule
         USE HOHQMeshModule, ONLY : ReadControlFile
         IMPLICIT NONE

         INTERFACE
            FUNCTION GetRealArray( inputLine ) RESULT(x)
               USE SMConstants
               REAL(KIND=RP), DIMENSION(3) :: x
               CHARACTER ( LEN = * )       :: inputLine
            END FUNCTION GetRealArray
         END INTERFACE

         INTEGER, PARAMETER :: MIN_SAMPLES = 200, SAMPLES_PER_KNOT = 8, BOX_SAMPLES = 100
         INTEGER, PARAMETER :: RAILS_PER_CURVE = 6, ARC_STEPS = 32
         ! Local to generate3DMesh upstream: the coordinate swept by a rotation about axis k.
         INTEGER, PARAMETER :: ROT_MAP(3) = [3, 3, 1]

         CHARACTER(LEN=DEFAULT_CHARACTER_LENGTH) :: controlFileName, outputFileName
         CHARACTER(LEN=9)                        :: generator
         TYPE (FTValueDictionary), POINTER       :: projectDict
         TYPE (FTValueDictionary), POINTER       :: controlDict, generatorDict
         CLASS(FTValueDictionary), POINTER       :: modelDict => NULL()
         ! Check3DMeshParametersIntegrity takes the non-polymorphic pointer.
         TYPE (FTValueDictionary), POINTER       :: modelDictType => NULL()
         CLASS(FTObject)         , POINTER       :: obj
         TYPE (SMModel)          , POINTER       :: model => NULL()
         CLASS(SMChainedCurve)   , POINTER       :: chain
         CLASS(SMCurve)          , POINTER       :: curve
         INTEGER                                 :: j, k, i, nSamples, fUnit, nChains
         INTEGER                                 :: pMutation = 3, rotAxis = 0
         REAL(KIND=RP)                           :: h = 0.0_RP
         REAL(KIND=RP), ALLOCATABLE              :: pts(:,:)
         CHARACTER(LEN=5)                        :: chainKind

         CALL initializeFTExceptions
         CALL GET_COMMAND_ARGUMENT(1, controlFileName)
         CALL GET_COMMAND_ARGUMENT(2, outputFileName)
         CALL ReadControlFile(controlFileName, projectDict)
         IF ( catch() ) CALL trapExceptions

         obj => projectDict % objectForKey(key = "CONTROL_INPUT")
         IF ( .NOT. ASSOCIATED(obj) ) ERROR STOP "CONTROL_INPUT block is missing from control file"
         controlDict => valueDictionaryFromObject(obj)

         obj => projectDict % objectForKey(key = "MODEL")
         IF ( ASSOCIATED(obj) )     THEN
            modelDict => valueDictionaryFromObject(obj)
            SELECT TYPE ( modelDict )
               TYPE IS ( FTValueDictionary )
                  modelDictType => modelDict
            END SELECT
            ALLOCATE(model)
            CALL model % initWithContentsOfDictionary(modelDict)
            IF ( catch() ) CALL trapExceptions
         END IF

         generator = "none"
         IF ( shouldGenerate3DMesh(controlDict) )     THEN
            CALL Check3DMeshParametersIntegrity(controlDict, modelDictType)
            IF ( catch() ) CALL trapExceptions
            CALL readGenerator
         END IF

         OPEN(NEWUNIT = fUnit, FILE = outputFileName)
         WRITE(fUnit, '(2A)') "GENERATOR ", TRIM(generator)
         nChains = 0

         IF ( ASSOCIATED(model) )     THEN
            nChains = model % numberOfChains()
            DO j = 1, nChains
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
                  IF ( ALLOCATED(pts) ) DEALLOCATE(pts)
                  ALLOCATE(pts(3, 0:nSamples))
                  DO i = 0, nSamples
                     pts(:,i) = lifted(curve % positionAt(REAL(i, RP)/nSamples))
                  END DO
                  CALL writeOutline(chainKind, TRIM(chain % curveName()) // " | " // TRIM(curve % curveName()), pts)
               END DO
            END DO

            IF ( ASSOCIATED(model % sweepCurve) )     THEN
               IF ( ALLOCATED(pts) ) DEALLOCATE(pts)
               ALLOCATE(pts(3, 0:MIN_SAMPLES))
               DO i = 0, MIN_SAMPLES
                  pts(:,i) = model % sweepCurve % positionAt(REAL(i, RP)/MIN_SAMPLES)
               END DO
               CALL writePolyline("sweep", TRIM(model % sweepCurve % curveName()) // " | sweep curve", pts)
            END IF
         END IF

         IF ( nChains == 0 ) CALL writeBackgroundBox

         CLOSE(fUnit)
         CALL destructFTExceptions

      CONTAINS

         ! The generator parameters exactly as generate3DMesh reads them.
         SUBROUTINE readGenerator
            IF ( controlDict % containsKey(key = SIMPLE_EXTRUSION_BLOCK_KEY) )     THEN
               obj           => controlDict % objectForKey(key = SIMPLE_EXTRUSION_BLOCK_KEY)
               generatorDict => valueDictionaryFromObject(obj)
               generator     =  "extrusion"
               pMutation     =  generatorDict % integerValueForKey(SIMPLE_SWEEP_DIRECTION_KEY)
               h             =  generatorDict % doublePrecisionValueForKey(SIMPLE_EXTRUSION_HEIGHT_KEY)
            ELSE IF ( controlDict % containsKey(key = SIMPLE_ROTATION_ALGORITHM_KEY) )     THEN
               obj           => controlDict % objectForKey(key = SIMPLE_ROTATION_ALGORITHM_KEY)
               generatorDict => valueDictionaryFromObject(obj)
               generator     =  "rotation"
               rotAxis       =  generatorDict % integerValueForKey(SIMPLE_SWEEP_DIRECTION_KEY)
               pMutation     =  ROT_MAP(rotAxis)
               h             =  PI * generatorDict % doublePrecisionValueForKey(SIMPLE_ROTATION_ANGLE_KEY)
            ELSE
               generator     =  "sweep"
            END IF
         END SUBROUTINE readGenerator

         FUNCTION lifted(p) RESULT(q)
            REAL(KIND=RP) :: p(3), q(3)
            q = p
            IF ( ASSOCIATED(model) )     THEN
               IF ( ASSOCIATED(model % topography) ) q = model % topography % heightAt(p(1:2))
            END IF
         END FUNCTION lifted

         ! Position of a (lifted) model point at fraction xi of the 3D sweep, following
         ! permuteMeshDirection, sweepNodes and RotateAll.
         FUNCTION swept(p, xi) RESULT(q)
            REAL(KIND=RP) :: p(3), xi, q(3), z
            q = p
            IF ( pMutation < 3 ) q = permutePosition(x = p, pmutation = pMutation)
            z = q(pMutation)*(1.0_RP - xi) + h*xi
            q = extrudedNodeLocation(baseLocation = q, delta = z, pmutation = pMutation)
            IF ( generator == "rotation" ) q = rotatedNodeLocation(baseLocation = q, theta = z, rotAxis = rotAxis)
         END FUNCTION swept

         SUBROUTINE writePolyline(kind, label, p)
            CHARACTER(LEN=*) :: kind, label
            REAL(KIND=RP)    :: p(:,:)
            INTEGER          :: m
            WRITE(fUnit, '(4A)') "CURVE ", kind, " ", label
            DO m = 1, SIZE(p, 2)
               WRITE(fUnit, '(3ES24.15)') p(:,m)
            END DO
         END SUBROUTINE writePolyline

         ! A model polyline as it appears in the mesh: as is in 2D; start and end of the
         ! sweep plus rails between them for an extrusion or rotation.
         SUBROUTINE writeOutline(kind, label, p)
            CHARACTER(LEN=*) :: kind, label
            REAL(KIND=RP)    :: p(:,0:)
            REAL(KIND=RP)    :: q(3, 0:UBOUND(p,2)), rail(3, 0:ARC_STEPS)
            INTEGER          :: n, m, r, s, steps

            n = UBOUND(p, 2)
            SELECT CASE ( TRIM(generator) )
               CASE ( "none" )
                  CALL writePolyline(kind, label, p)
               CASE ( "sweep" )
                  CALL writePolyline("section", label, p)
               CASE DEFAULT
                  DO m = 0, n
                     q(:,m) = swept(p(:,m), 0.0_RP)
                  END DO
                  CALL writePolyline(kind, label // " (start)", q)
                  DO m = 0, n
                     q(:,m) = swept(p(:,m), 1.0_RP)
                  END DO
                  CALL writePolyline(kind, label // " (end)", q)

                  steps = 1
                  IF ( generator == "rotation" ) steps = ARC_STEPS
                  ! Rails start at the beginning of each curve but not its end, so
                  ! curves joined in a chain do not get the joint twice.
                  DO r = 0, RAILS_PER_CURVE - 1
                     m = (r*n)/RAILS_PER_CURVE
                     DO s = 0, steps
                        rail(:,s) = swept(p(:,m), REAL(s, RP)/steps)
                     END DO
                     CALL writePolyline("rail", label, rail(:,0:steps))
                  END DO
            END SELECT
         END SUBROUTINE writeOutline

         SUBROUTINE writeBackgroundBox
            CLASS(FTValueDictionary), POINTER :: gridDict
            REAL(KIND=RP)                     :: x0(3), dx(3), nCells(3), corners(2,5), s
            INTEGER                           :: e, m

            obj => controlDict % objectForKey(key = "BACKGROUND_GRID")
            IF ( .NOT. ASSOCIATED(obj) ) RETURN
            gridDict => valueDictionaryFromObject(obj)
            IF ( .NOT. (gridDict % containsKey("x0") .AND. gridDict % containsKey("dx") &
                        .AND. gridDict % containsKey("N")) ) RETURN

            x0     = GetRealArray(gridDict % stringValueForKey("x0", DEFAULT_CHARACTER_LENGTH))
            dx     = GetRealArray(gridDict % stringValueForKey("dx", DEFAULT_CHARACTER_LENGTH))
            nCells = GetRealArray(gridDict % stringValueForKey("N" , DEFAULT_CHARACTER_LENGTH))

            corners(:,1) = [x0(1)                  , x0(2)]
            corners(:,2) = [x0(1) + nCells(1)*dx(1), x0(2)]
            corners(:,3) = [x0(1) + nCells(1)*dx(1), x0(2) + nCells(2)*dx(2)]
            corners(:,4) = [x0(1)                  , x0(2) + nCells(2)*dx(2)]
            corners(:,5) = corners(:,1)

            ! One polyline per edge, so each corner starts a curve and gets a rail.
            IF ( ALLOCATED(pts) ) DEALLOCATE(pts)
            ALLOCATE(pts(3, 0:BOX_SAMPLES))
            DO e = 1, 4
               DO m = 0, BOX_SAMPLES
                  s = REAL(m, RP)/BOX_SAMPLES
                  pts(:, m) = lifted([corners(:,e)*(1.0_RP - s) + corners(:,e+1)*s, 0.0_RP])
               END DO
               CALL writeOutline("box", "Background grid | box", pts)
            END DO
         END SUBROUTINE writeBackgroundBox

      END PROGRAM BoundaryPreview
